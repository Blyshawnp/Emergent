# Archived shared-user migration plan

`20260614083525_shared_user_accounts_targeted_alerts.sql` was removed from the active Supabase migration chain before the MTS/SAM data-foundation checkpoint.

The migration belongs to an earlier, unrelated public-schema user-account and targeted-alert design. It was never part of the five approved `mts_sam` migrations and must not be applied as a prerequisite for the MTS/SAM foundation. The SQL is preserved byte-for-byte beside this explanation for historical review; its SHA-256 at archival time was `0906738F0C47F36637C50D42C1CFBC84A57A7B041C7140EEEAEC0AB733A5319B`.

Archiving this plan does not mark it as applied, change hosted migration history, or authorize deploying it later. Any future decision to revive it requires separate review and a new migration plan.
