import { createClient } from "npm:@supabase/supabase-js@2";

interface RequestPayload {
  target_user_id?: string;
  caller_auth_uid?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "Hosted service configuration is missing." }),
        { status: 500, headers: corsHeaders }
      );
    }

    // 1. Extract Bearer token
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!jwt) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Missing Authorization Bearer token." }),
        { status: 401, headers: corsHeaders }
      );
    }

    // 2. Authenticate caller using Supabase Auth
    const callerClient = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });

    const { data: { user: callerAuthUser }, error: callerAuthError } = await callerClient.auth.getUser();

    if (callerAuthError || !callerAuthUser?.id) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Invalid or expired caller token." }),
        { status: 401, headers: corsHeaders }
      );
    }

    const callerAuthUid = callerAuthUser.id;

    // Parse body
    let body: RequestPayload = {};
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON request body." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const targetUserId = (body.target_user_id || "").trim();
    if (!targetUserId) {
      return new Response(
        JSON.stringify({ ok: false, error: "Target user ID is required." }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Hard Spoofing Defense: If client passed caller_auth_uid, it must match the verified JWT
    if (body.caller_auth_uid && body.caller_auth_uid.trim().toLowerCase() !== callerAuthUid.toLowerCase()) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "CALLER_IDENTITY_MISMATCH",
          error: "Client-supplied caller UID does not match verified JWT identity.",
        }),
        { status: 403, headers: corsHeaders }
      );
    }

    // Privileged admin client inside hosted function
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // 3. Verify caller is active in mts_sam.app_users
    const { data: callerRecord, error: callerFetchError } = await adminClient
      .schema("mts_sam")
      .from("app_users")
      .select("id, active, display_name")
      .eq("auth_user_id", callerAuthUid)
      .eq("active", true)
      .maybeSingle();

    if (callerFetchError || !callerRecord) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized caller: Not an active SAM operator." }),
        { status: 403, headers: corsHeaders }
      );
    }

    // 4. Verify caller has administrator or owner role
    const { data: callerRoleAssignments, error: roleError } = await adminClient
      .schema("mts_sam")
      .from("user_role_assignments")
      .select("role_key")
      .eq("user_id", callerRecord.id)
      .is("revoked_at", null);

    const hasAdminRole = (callerRoleAssignments || []).some(
      (r: { role_key: string }) => r.role_key === "administrator" || r.role_key === "owner"
    );

    if (roleError || !hasAdminRole) {
      return new Response(
        JSON.stringify({ ok: false, error: "Forbidden: Only administrators or owners can enroll users." }),
        { status: 403, headers: corsHeaders }
      );
    }

    // 5. Verify target user exists in mts_sam.app_users
    const { data: targetRecord, error: targetFetchError } = await adminClient
      .schema("mts_sam")
      .from("app_users")
      .select("id, display_name, active, auth_user_id, metadata")
      .eq("id", targetUserId)
      .maybeSingle();

    if (targetFetchError || !targetRecord) {
      return new Response(
        JSON.stringify({ ok: false, error: "Target user not found." }),
        { status: 404, headers: corsHeaders }
      );
    }

    const rawEmail = targetRecord.metadata?.email;
    const targetEmail = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

    if (!targetEmail || !targetEmail.includes("@")) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "User does not have a valid email configured. Please configure email first in User Management.",
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 6. Check if target user is already linked in app_users
    if (targetRecord.auth_user_id) {
      // Send password recovery / setup link
      const { error: resetError } = await adminClient.auth.resetPasswordForEmail(targetEmail, {
        redirectTo: "smartalertmanager://reset-password",
      });

      if (resetError) {
        return new Response(
          JSON.stringify({ ok: false, error: `Failed to dispatch setup email: ${resetError.message}` }),
          { status: 500, headers: corsHeaders }
        );
      }

      // Record invited_at timestamp
      const updatedMetadata = {
        ...(targetRecord.metadata || {}),
        invited_at: new Date().toISOString(),
      };
      await adminClient
        .schema("mts_sam")
        .from("app_users")
        .update({ metadata: updatedMetadata, updated_at: new Date().toISOString() })
        .eq("id", targetUserId);

      return new Response(
        JSON.stringify({
          ok: true,
          status: "already_linked",
          user_id: targetUserId,
          auth_user_id: targetRecord.auth_user_id,
          email: targetEmail,
          message: `Account setup email sent to ${targetEmail}.`,
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // 7. Check auth.users collision
    const { data: usersData, error: listUsersError } = await adminClient.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (listUsersError) {
      return new Response(
        JSON.stringify({ ok: false, error: `Failed to check Auth identity: ${listUsersError.message}` }),
        { status: 500, headers: corsHeaders }
      );
    }

    const existingAuthUser = (usersData.users || []).find(
      (u: { email?: string }) => (u.email || "").trim().toLowerCase() === targetEmail
    );

    let linkedAuthUserId: string;
    let enrollmentOutcome: string;

    if (existingAuthUser) {
      // Auth user already exists in GoTrue. Verify it is not linked to another app_users row
      const { data: existingAppUsersWithAuth, error: checkCollisionError } = await adminClient
        .schema("mts_sam")
        .from("app_users")
        .select("id, display_name")
        .eq("auth_user_id", existingAuthUser.id)
        .neq("id", targetUserId);

      if (checkCollisionError) {
        return new Response(
          JSON.stringify({ ok: false, error: "Failed to verify Auth identity ownership." }),
          { status: 500, headers: corsHeaders }
        );
      }

      if (existingAppUsersWithAuth && existingAppUsersWithAuth.length > 0) {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: "AUTH_IDENTITY_ALREADY_EXISTS_CONFLICT",
            error: "An authentication identity with this email already exists and is linked to another application user.",
          }),
          { status: 409, headers: corsHeaders }
        );
      }

      linkedAuthUserId = existingAuthUser.id;
      enrollmentOutcome = "linked_existing";

      // Send setup/recovery email
      const { error: resetErr } = await adminClient.auth.resetPasswordForEmail(targetEmail, {
        redirectTo: "smartalertmanager://reset-password",
      });
      if (resetErr) {
        return new Response(
          JSON.stringify({ ok: false, error: `Failed to send setup email: ${resetErr.message}` }),
          { status: 500, headers: corsHeaders }
        );
      }
    } else {
      // 8. User does NOT exist in auth.users -> FIRST-TIME CREATION!
      const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
        targetEmail,
        { redirectTo: "smartalertmanager://reset-password" }
      );

      if (inviteError || !inviteData?.user?.id) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: `Failed to create Supabase Auth user: ${inviteError?.message || "Unknown error"}`,
          }),
          { status: 500, headers: corsHeaders }
        );
      }

      linkedAuthUserId = inviteData.user.id;
      enrollmentOutcome = "created_and_invited";
    }

    // 9. Safely link auth_user_id and record invited_at in mts_sam.app_users
    const updatedMetadata = {
      ...(targetRecord.metadata || {}),
      invited_at: new Date().toISOString(),
    };

    const { error: linkError } = await adminClient
      .schema("mts_sam")
      .from("app_users")
      .update({
        auth_user_id: linkedAuthUserId,
        metadata: updatedMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetUserId);

    if (linkError) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Auth identity created/verified, but failed to link application user: ${linkError.message}`,
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: enrollmentOutcome,
        user_id: targetUserId,
        auth_user_id: linkedAuthUserId,
        email: targetEmail,
        message:
          enrollmentOutcome === "created_and_invited"
            ? `New authentication account created and setup invitation email sent to ${targetEmail}.`
            : `Authentication account linked and setup email sent to ${targetEmail}.`,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
