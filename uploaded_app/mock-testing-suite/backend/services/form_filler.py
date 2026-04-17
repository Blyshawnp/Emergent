"""
form_filler.py — Selenium automation for the Cert Test Call Results Form.
Opens the form URL in Chrome, fills fields by XPATH, and leaves the browser
open (detached) so the user can review and manually click Submit.
"""
import threading
from typing import Optional


# Map auto-fail reason text to the form's radio button values
AUTO_FAIL_MAP = {
    "nc/ns": "NC/NS",
    "nc / ns": "NC/NS",
    "not ready": "Not ready for session",
    "stopped": "Stopped responding in chat",
    "vpn": "Unable to turn off VPN",
    "usb": "Wrong headset (not USB)",
    "noise": "Wrong headset (not noise cancelling)",
}


def fill_form(form_url: str, data: dict) -> dict:
    """
    Fill the Cert Test Call Results Form using Selenium.
    Runs in a background thread so the API doesn't block.

    Expected data keys:
        tester_name, candidate_name, skills (list), mock_complete, sup_complete,
        all_complete, newbie_shift, auto_fail, headset, coaching, fail_reason

    Returns {"ok": True/False, "message": "..."}.
    """
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.service import Service as ChromeService
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from webdriver_manager.chrome import ChromeDriverManager
    except ImportError:
        return {
            "ok": False,
            "message": "Missing packages. Run: pip install selenium webdriver-manager",
        }

    try:
        service = ChromeService(ChromeDriverManager().install())
        options = webdriver.ChromeOptions()
        options.add_experimental_option("detach", True)  # Keep browser open
        driver = webdriver.Chrome(service=service, options=options)

        driver.get(form_url)
        wait = WebDriverWait(driver, 15)

        # Wait for first question to load
        wait.until(EC.presence_of_element_located((
            By.XPATH,
            "//input[@aria-labelledby[contains(., 'QuestionId_r01b0d230b9fe4eb6839356672314e9e7')]]"
        )))

        def fill_text(xpath, text):
            el = driver.find_element(By.XPATH, xpath)
            el.clear()
            el.send_keys(text)

        def click_elem(xpath):
            el = driver.find_element(By.XPATH, xpath)
            driver.execute_script("arguments[0].click();", el)

        # Q1: Tester Name
        fill_text(
            "//input[@aria-labelledby[contains(., 'QuestionId_r01b0d230b9fe4eb6839356672314e9e7')]]",
            data.get("tester_name", ""),
        )

        # Q2: Candidate Name
        fill_text(
            "//input[@aria-labelledby[contains(., 'QuestionId_r27729863e89544849ec8daae00435dd6')]]",
            data.get("candidate_name", ""),
        )

        # Q3: Skills Tested (checkboxes)
        skills = data.get("skills", [])
        if "Mock Calls" in skills:
            click_elem("//input[@name='rf08c78b7b1954fa4b1c1fd1f5d8e9471' and @value='Mock Calls']")
        if "Supervisor Transfer" in skills:
            click_elem("//input[@name='rf08c78b7b1954fa4b1c1fd1f5d8e9471' and @value='Supervisor Transfer']")

        # Q4: Mock Calls Complete
        click_elem(
            f"//input[@name='r2cda4abee0d2429d8351d8224adabad6' and @value='{data.get('mock_complete', 'No')}']"
        )

        # Q5: Sup Transfer Complete
        click_elem(
            f"//input[@name='r1628b7c769be4991b6ebcf9e97bccfa5' and @value='{data.get('sup_complete', 'No')}']"
        )

        # Q6: All Complete
        click_elem(
            f"//input[@name='r2226db45226d48fd884e526b8285a209' and @value='{data.get('all_complete', 'No')}']"
        )

        # Q7: Newbie Shift
        fill_text(
            "//textarea[@aria-labelledby[contains(., 'QuestionId_r07b473b06d324ce396d4e8d6a71c36ac')]]",
            data.get("newbie_shift", "N/A"),
        )

        # Q8: Auto Fail Reason
        auto_fail_raw = data.get("auto_fail", "N/A").lower()
        matched_fail = "N/A"
        for keyword, form_value in AUTO_FAIL_MAP.items():
            if keyword in auto_fail_raw:
                matched_fail = form_value
                break
        click_elem(
            f"//input[@name='r72a42d8610854e559a511d2cc45317af' and contains(@value, '{matched_fail}')]"
        )

        # Q9: Headset
        fill_text(
            "//textarea[@aria-labelledby[contains(., 'QuestionId_r2b82dbb1e21b41ebb40feae8783afa50')]]",
            data.get("headset", "N/A"),
        )

        # Q10: Tech Issues (default N/A)
        click_elem(
            "//input[@name='r685b9cb30c6349af98d68d74428cfa71' and @value='N/A']"
        )

        # Q11: Coaching Summary
        fill_text(
            "//textarea[@aria-labelledby[contains(., 'QuestionId_ra5565add539446ffa320b0ba059bd4dd')]]",
            data.get("coaching", ""),
        )

        # Q12: Fail Reason
        fill_text(
            "//textarea[@aria-labelledby[contains(., 'QuestionId_r9c14ae7b1b0c4cf28c6d60615aa97fab')]]",
            data.get("fail_reason", "N/A"),
        )

        return {"ok": True, "message": "Form filled successfully. Review and click Submit in Chrome."}

    except Exception as e:
        return {"ok": False, "message": str(e)}


def fill_form_async(form_url: str, data: dict, callback=None):
    """Run fill_form in a background thread."""
    def _run():
        result = fill_form(form_url, data)
        if callback:
            callback(result)
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t
