#!/usr/bin/env python3
"""
Backend API Testing for Mock Testing Suite v3.0
Tests all required API endpoints as specified in the review request.
"""

import requests
import json
import sys
from datetime import datetime

class MockTestingSuiteAPITester:
    def __init__(self, base_url="http://localhost:8001/api"):
        self.base_url = base_url
        self.tests_run = 0
        self.tests_passed = 0
        self.session_id = None

    def run_test(self, name, method, endpoint, expected_status, data=None, check_response=None):
        """Run a single API test"""
        url = f"{self.base_url}{endpoint}"
        headers = {'Content-Type': 'application/json'}

        self.tests_run += 1
        print(f"\n🔍 Testing {name}...")
        print(f"   URL: {url}")
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, timeout=10)
            elif method == 'PUT':
                response = requests.put(url, json=data, headers=headers, timeout=10)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers, timeout=10)

            success = response.status_code == expected_status
            if success:
                self.tests_passed += 1
                print(f"✅ Passed - Status: {response.status_code}")
                
                # Additional response validation if provided
                if check_response and response.content:
                    try:
                        response_data = response.json()
                        if check_response(response_data):
                            print(f"   ✅ Response validation passed")
                        else:
                            print(f"   ⚠️ Response validation failed")
                            success = False
                            self.tests_passed -= 1
                    except Exception as e:
                        print(f"   ⚠️ Response validation error: {e}")
                
                return success, response.json() if response.content else {}
            else:
                print(f"❌ Failed - Expected {expected_status}, got {response.status_code}")
                if response.content:
                    try:
                        error_data = response.json()
                        print(f"   Error: {error_data}")
                    except:
                        print(f"   Error: {response.text}")
                return False, {}

        except Exception as e:
            print(f"❌ Failed - Error: {str(e)}")
            return False, {}

    def test_settings_get(self):
        """Test GET /api/settings - should return settings with setup_complete=true"""
        def check_settings(data):
            return 'setup_complete' in data and data['setup_complete'] == True
        
        return self.run_test(
            "GET Settings",
            "GET",
            "/settings",
            200,
            check_response=check_settings
        )

    def test_settings_defaults(self):
        """Test GET /api/settings/defaults - should return call_types, shows, donors, tech_issues"""
        def check_defaults(data):
            required_keys = ['call_types', 'shows', 'donors_new', 'donors_existing', 'tech_issues']
            return all(key in data for key in required_keys)
        
        return self.run_test(
            "GET Settings Defaults",
            "GET",
            "/settings/defaults",
            200,
            check_response=check_defaults
        )

    def test_history_stats(self):
        """Test GET /api/history/stats - should return stats object"""
        def check_stats(data):
            required_keys = ['total', 'passes', 'fails', 'ncns', 'incomplete', 'pass_rate']
            return all(key in data for key in required_keys)
        
        return self.run_test(
            "GET History Stats",
            "GET",
            "/history/stats",
            200,
            check_response=check_stats
        )

    def test_session_start(self):
        """Test POST /api/session/start - should create a session"""
        session_data = {
            "candidate_name": "Test Candidate",
            "tester_name": "Test Tester",
            "pronoun": "They",
            "final_attempt": False,
            "headset_usb": True,
            "noise_cancel": True,
            "headset_brand": "Logitech H390",
            "vpn_on": False,
            "chrome_default": True,
            "extensions_disabled": True,
            "popups_allowed": True
        }
        
        def check_session(data):
            return 'ok' in data and data['ok'] == True and 'session' in data
        
        success, response = self.run_test(
            "POST Session Start",
            "POST",
            "/session/start",
            200,
            data=session_data,
            check_response=check_session
        )
        
        if success and 'session' in response:
            self.session_id = response['session'].get('candidate_name')
        
        return success, response

    def test_session_call(self):
        """Test POST /api/session/call - should save call data"""
        call_data = {
            "call_num": 1,
            "result": "Pass",
            "type": "New Donor - One Time Donation",
            "show": "PBS NewsHour",
            "caller": "John Smith",
            "donation": "$60",
            "coaching": {"Show appreciation": True},
            "coach_notes": "Good job",
            "fails": {},
            "fail_notes": ""
        }
        
        def check_call(data):
            return 'ok' in data and data['ok'] == True
        
        return self.run_test(
            "POST Session Call",
            "POST",
            "/session/call",
            200,
            data=call_data,
            check_response=check_call
        )

    def test_gemini_summaries(self):
        """Test POST /api/gemini/summaries - should generate coaching and fail summaries"""
        def check_summaries(data):
            return 'coaching' in data and 'fail' in data
        
        return self.run_test(
            "POST Gemini Summaries",
            "POST",
            "/gemini/summaries",
            200,
            check_response=check_summaries
        )

    def test_finish_session(self):
        """Test POST /api/finish-session - should finalize and move to history"""
        finish_data = {
            "coaching_summary": "Test coaching summary",
            "fail_summary": "Test fail summary"
        }
        
        def check_finish(data):
            return 'ok' in data and data['ok'] == True
        
        return self.run_test(
            "POST Finish Session",
            "POST",
            "/finish-session",
            200,
            data=finish_data,
            check_response=check_finish
        )

def main():
    """Run all backend API tests"""
    print("🚀 Starting Mock Testing Suite v3.0 Backend API Tests")
    print("=" * 60)
    
    tester = MockTestingSuiteAPITester()
    
    # Test all required endpoints
    test_results = []
    
    # 1. Test settings endpoint
    success, _ = tester.test_settings_get()
    test_results.append(("GET /api/settings", success))
    
    # 2. Test settings defaults
    success, _ = tester.test_settings_defaults()
    test_results.append(("GET /api/settings/defaults", success))
    
    # 3. Test history stats
    success, _ = tester.test_history_stats()
    test_results.append(("GET /api/history/stats", success))
    
    # 4. Test session start
    success, _ = tester.test_session_start()
    test_results.append(("POST /api/session/start", success))
    
    # 5. Test session call (only if session was created)
    if tester.session_id:
        success, _ = tester.test_session_call()
        test_results.append(("POST /api/session/call", success))
    
    # 6. Test gemini summaries
    success, _ = tester.test_gemini_summaries()
    test_results.append(("POST /api/gemini/summaries", success))
    
    # 7. Test finish session
    success, _ = tester.test_finish_session()
    test_results.append(("POST /api/finish-session", success))
    
    # Print summary
    print("\n" + "=" * 60)
    print("📊 TEST SUMMARY")
    print("=" * 60)
    
    for test_name, success in test_results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} {test_name}")
    
    print(f"\n📈 Overall: {tester.tests_passed}/{tester.tests_run} tests passed")
    
    if tester.tests_passed == tester.tests_run:
        print("🎉 All backend API tests passed!")
        return 0
    else:
        print("⚠️ Some backend API tests failed!")
        return 1

if __name__ == "__main__":
    sys.exit(main())
