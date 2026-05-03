import html
import logging
import os
import sys
fram typing import Iterable


QUESTION_IDS = {
    "tester_name": "QuestionId_r01b0d230b9fe4eb6839356672314e9e7",
    "candidate_name": "QuestionId_r27729863e89544849ec8daae00435dd6",
    "skills": "QuestionId_rf08c78b7b1954fa4b1c1fd1f5d8e9471",
    "newbie_shift": "QuestionId_r07b473b06d324ce396d4e8d6a71c36ac",
    "headset": "QuestionId_r2b82dbb1e21b41ebb40feae8783afa50",
    "coaching": "QuestionId_ra5565add539446ffa320b0ba059bd4dd",
    "fail_reason": "QuestionId_r9c14ae7b1b0c4cf28c6d60615aa97fab",
    "tech_issue": "QuestionId_r685b9cb30c6349af98d68d74428cfa71",
}

QUESTION_NAMES = {
    "mock_complete": "r2cda4abee0d2429d8351d8224adabad6",
    "sup_complete": "r1628b7c769be4991b6ebcf9e97bccfa5",
    "all_complete": "r2226db45226d48fd884e526b8285a209",
    "auto_fail": "r72a42d8610854e559a511d2cc45317af",
    "tech_issue": "r685b9cb30c6349af98d68d74428cfa71",
}


def _normalize_text(value: str) -> str:
    cleaned = html.unescape(value or "").replace("\xa0", " ")
    return " ".join(cleaned.split()).strip()


def _normalize_key(value: str) -> str:
    return _normalize_text(value).lower()


logger = logging.getLogger(__name__)


def _build_chromium_options(options):
    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_experimental_option("detach", True)
    return options


def _resolve_driver_directories():
    directories = []

    def add_directory(candidate):
        normalized = os.path.normcase(os.path.abspath(candidate))
        if os.path.isdir(candidate) and normalized not in directories:
            directories.append(normalized)

    explicit = os.environ.get("BROWSER_DRIVER_DIR", "").strip()
    if explicit:
        add_directory(explicit)

    resources_root = os.environ.get("APP_RESOURCES_PATH", "").strip()
    if resources_root:
        add_directory(os.path.join(resources_root, "backend", "drivers"))

    if getattr(sys, "frozen", False):
        add_directory(os.path.join(os.path.dirname(sys.executable), "drivers"))

    add_directory(os.path.join(os.path.dirname(os.path.dirname(__file__)), "drivers"))
    return directories


def _resolve_driver_path(filename: str):
    checked_paths = []
    for directory in _resolve_driver_directories():
        candidate = os.path.join(directory, filename)
        checked_paths.append(candidate)
        if os.path.isfile(candidate):
            return candidate, checked_paths
    return "", checked_paths


def _resolve_browser_order(preferred_browser: str):
    browser = _normalize_key(preferred_browser or "auto")
    if browser == "chrome":
        return ["chrome", "edge"]
    if browser == "edge":
        return ["edge", "chrome"]
    return ["chrome", "edge"]


def _create_driver(preferred_browser: str = "auto"):
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service as ChromeService
    from selenium.webdriver.edge.service import Service as EdgeService

    errors = []
    drivers = {
        "chrome": {
            "display": "Chrome",
            "filename": "chromedriver",
            "factory": lambda driver_path: webdriver.Chrome(
                service=ChromeService(executable_path=driver_path),
                options=_build_chromium_options(webdriver.ChromeOptions()),
            ),
        },
        "edge": {
            "display": "Edge",
            "filename": "msedgedriver",
            "factory": lambda driver_path: webdriver.Edge(
                service=EdgeService(executable_path=driver_path),
                options=_build_chromium_options(webdriver.EdgeOptions()),
            ),
        },
    }

    browser_order = _resolve_browser_order(preferred_browser)
    logger.info(
        "Starting browser automation with preference '%s'. Driver directories: %s",
        preferred_browser or "auto",
        ", ".join(_resolve_driver_directories()) or "none found",
    )

    for browser_key in browser_order:
        config = drivers[browser_key]
        driver_path, checked_paths = _resolve_driver_path(config["filename"])
        if not driver_path:
            errors.append(f"{config['display']}: missing {config['filename']} (checked: {', '.join(checked_paths) or 'no driver directories found'})")
            continue

        logger.info("Attempting to launch %s using %s", config["display"], driver_path)
        try:
            driver = config["factory"](driver_path)
            return driver, config["display"]
        except Exception as exc:
            logger.exception("Failed to launch %s browser automation", config["display"])
            errors.append(f"{config['display']}: {exc}")

    raise RuntimeError("Could not launch a supported browser for form automation. " + " | ".join(errors))


def _wait_for_form(driver):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    wait = WebDriverWait(driver, 45)
    wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR, "[data-automation-id='questionItem']")))
    wait.until(EC.presence_of_element_located((By.ID, QUESTION_IDS["tester_name"])))
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "button[data-automation-id='submitButton']")))
    return wait


def _find_question(driver, question_id: str, wait=None):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    try:
        if wait:
            header = wait.until(EC.presence_of_element_located((By.ID, question_id)))
        else:
            header = driver.find_element(By.ID, question_id)
        return header.find_element(By.XPATH, "./ancestor::*[@data-automation-id='questionItem'][1]")
    except Exception as exc:
        raise RuntimeError(f"Could not find form question '{question_id}'.") from exc


def _click(driver, element):
    driver.execute_script("arguments[0].click();", element)


def _question_title(question):
    from selenium.webdriver.common.by import By

    try:
        title = question.find_element(By.CSS_SELECTOR, "[data-automation-id='questionTitle']")
        return _normalize_text(title.text)
    except Exception:
        return "Unknown question"


def _set_text_input(driver, question_id: str, value: str, wait):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    question = _find_question(driver, question_id, wait)
    title = _question_title(question)
    try:
        input_el = wait.until(lambda d: question.find_element(By.CSS_SELECTOR, "input[data-automation-id='textInput']"))
    except Exception as exc:
        raise RuntimeError(f"Could not find text input for question '{question_id}'.") from exc
    logger.info("Filling text input: %s", title)
    wait.until(EC.element_to_be_clickable(input_el))
    input_el.clear()
    input_el.send_keys(value or "")


def _set_textarea(driver, question_id: str, value: str, wait):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    question = _find_question(driver, question_id, wait)
    title = _question_title(question)
    try:
        input_el = wait.until(lambda d: question.find_element(By.CSS_SELECTOR, "textarea[data-automation-id='textInput']"))
    except Exception as exc:
        raise RuntimeError(f"Could not find textarea for question '{question_id}'.") from exc
    logger.info("Filling textarea: %s", title)
    wait.until(EC.element_to_be_clickable(input_el))
    input_el.clear()
    input_el.send_keys(value or "")


def _select_choices(driver, question_id: str, expected_values: Iterable[str], wait):
    from selenium.webdriver.common.by import By

    normalized_expected = {_normalize_key(value): value for value in expected_values if _normalize_text(value)}
    question = _find_question(driver, question_id, wait)
    title = _question_title(question)
    labels = wait.until(lambda d: question.find_elements(By.CSS_SELECTOR, "label"))
    logger.info("Selecting checkbox values for: %s -> %s", title, ", ".join(normalized_expected.values()))

    for label in labels:
        try:
            input_el = label.find_element(By.CSS_SELECTOR, "input[type='checkbox']")
        except Exception:
            continue
        label_key = _normalize_key(label.text)
        value_key = _normalize_key(input_el.get_attribute("value") or "")
        for expected_key in list(normalized_expected.keys()):
            if expected_key and expected_key in {label_key, value_key}:
                if not input_el.is_selected():
                    _click(driver, input_el)
                normalized_expected.pop(expected_key, None)
                break

    if normalized_expected:
        missing = ", ".join(normalized_expected.values())
        raise RuntimeError(f"Could not match checkbox values: {missing}")


def _select_single_choice(driver, question_name: str, expected_value: str, wait, question_label=None):
    from selenium.webdriver.common.by import By

    expected_key = _normalize_key(expected_value)
    logger.info("Selecting radio value for: %s -> %s", question_label or question_name, expected_value)
    radios = wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, f"input[type='radio'][name='{question_name}']"))

    for radio in radios:
        value_key = _normalize_key(radio.get_attribute("value") or "")
        label_key = ""
        try:
            label_key = _normalize_key(radio.find_element(By.XPATH, "./ancestor::label[1]").text)
        except Exception:
            label_key = ""
        if expected_key in {value_key, label_key}:
            if not radio.is_selected():
                _click(driver, radio)
            return

    raise RuntimeError(f"Could not match radio value '{expected_value}' for question '{question_name}'.")


def _select_tech_issue(driver, choice: str, other_text: str, wait):
    from selenium.webdriver.common.by import By

    logger.info("Selecting technical issue: %s", choice)
    if choice == "Other":
        question = _find_question(driver, QUESTION_IDS["tech_issue"], wait)
        try:
            other_radio = wait.until(lambda d: question.find_element(By.CSS_SELECTOR, "input[type='radio'][aria-label='Other answer']"))
            other_input = wait.until(lambda d: question.find_element(By.CSS_SELECTOR, "input[data-automation-id='textInput'][placeholder='Other']"))
        except Exception as exc:
            raise RuntimeError("Could not find the Microsoft Forms 'Other' tech issue controls.") from exc
        if not other_radio.is_selected():
            _click(driver, other_radio)
        logger.info("Filling technical issue Other text")
        other_input.clear()
        other_input.send_keys(other_text or "Other")
        return

    _select_single_choice(driver, QUESTION_NAMES["tech_issue"], choice, wait, "Script or Technical Issues")


def fill_form(form_url: str, data: dict, preferred_browser: str = "auto") -> dict:
    try:
        from selenium.common.exceptions import WebDriverException
    except ImportError:
        return {
            "ok": False,
            "message": "Selenium is not installed for the backend Python environment. Run: pip install -r backend/requirements.txt",
        }

    driver = None
    browser_name = None

    try:
        logger.info("Starting Microsoft Forms automation")
        driver, browser_name = _create_driver(preferred_browser)
        driver.set_page_load_timeout(60)
        driver.get(form_url)
        wait = _wait_for_form(driver)

        _set_text_input(driver, QUESTION_IDS["tester_name"], data.get("tester_name", ""), wait)
        _set_text_input(driver, QUESTION_IDS["candidate_name"], data.get("candidate_name", ""), wait)
        _select_choices(driver, QUESTION_IDS["skills"], data.get("skills", []), wait)
        _select_single_choice(driver, QUESTION_NAMES["mock_complete"], data.get("mock_complete", "No"), wait, "Mock Complete?")
        _select_single_choice(driver, QUESTION_NAMES["sup_complete"], data.get("sup_complete", "No"), wait, "Supervisor Transfer Complete?")
        _select_single_choice(driver, QUESTION_NAMES["all_complete"], data.get("all_complete", "No"), wait, "All Complete")
        _set_textarea(driver, QUESTION_IDS["newbie_shift"], data.get("newbie_shift", "N/A"), wait)
        _select_single_choice(driver, QUESTION_NAMES["auto_fail"], data.get("auto_fail", "N/A"), wait, "Automatic Fail")
        _set_textarea(driver, QUESTION_IDS["headset"], data.get("headset", "N/A"), wait)
        _select_tech_issue(driver, data.get("tech_issue_choice", "N/A"), data.get("tech_issue_other", ""), wait)
        _set_textarea(driver, QUESTION_IDS["coaching"], data.get("coaching", ""), wait)
        _set_textarea(driver, QUESTION_IDS["fail_reason"], data.get("fail_reason", "N/A"), wait)

        logger.info("Microsoft Forms automation completed successfully")

        return {
            "ok": True,
            "message": f"The Cert Form was opened and populated in {browser_name}. Review it and click Submit when ready.",
        }
    except WebDriverException as exc:
        logger.exception("Browser automation failed to start")
        return {"ok": False, "message": f"Browser automation failed to start: {exc}"}
    except Exception as exc:
        logger.exception("Microsoft Forms automation failed")
        return {"ok": False, "message": str(exc)}
