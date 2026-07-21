#!/usr/bin/env python3
"""Browser smoke proof for the suite-provenance MVP (fixes 1-3).

Asserts, against the live studio (:3411) + smoke API (:3410, Google endpoints
stubbed, credentials seeded with metadata=null):
  1. setup.field_autopopulated fills gmailAccountEmail with the BACKFILLED email
     (the credential row started with metadata = null).
  2. The setup panel labels the cross-type suite binding with provenance
     ("via your Google Drive credential (drive-user@example.com)") and emits
     setup.suite_provenance_shown (surface=setup_panel).
  3. The credentials page shows "Also grants: Google Sheets, Google Calendar"
     on the Drive credential and emits setup.suite_provenance_shown
     (surface=credentials_page).
"""
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

STUDIO = "http://localhost:3411"
FLOW_ID = 1
ART = "/home/unix/bubblelab-prov/pw-artifacts"

telemetry = []


def on_console(msg):
    text = msg.text
    if "[bl:telemetry]" in text:
        payload = text.split("[bl:telemetry]", 1)[1].strip()
        try:
            telemetry.append(json.loads(payload))
        except json.JSONDecodeError:
            pass


def events(name):
    return [e for e in telemetry if e.get("event") == name]


def wait_for_event(name, predicate=lambda e: True, timeout_s=30):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        hits = [e for e in events(name) if predicate(e)]
        if hits:
            return hits
        time.sleep(0.25)
    raise AssertionError(f"telemetry event not seen: {name}")


failures = []


def check(label, fn):
    try:
        fn()
        print(f"PASS {label}")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{label}: {exc}")
        print(f"FAIL {label}: {exc}")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.on("console", on_console)

    # ── Flow page: autoPopulate + suite binding + provenance label ──────────
    page.goto(f"{STUDIO}/flow/{FLOW_ID}", wait_until="domcontentloaded")
    page.wait_for_timeout(4000)

    check(
        "fix1: gmailAccountEmail autopopulated from BACKFILLED email",
        lambda: wait_for_event(
            "setup.field_autopopulated",
            lambda e: e.get("field") == "gmailAccountEmail"
            and e.get("value") == "gmail-user@example.com",
        ),
    )
    check(
        "fix2: suite binding proposed for GOOGLE_SHEETS_CRED from drive cred",
        lambda: wait_for_event(
            "setup.suite_binding_proposed",
            lambda e: e.get("requiredCredentialType") == "GOOGLE_SHEETS_CRED"
            and e.get("sourceCredentialType") == "GOOGLE_DRIVE_CRED",
        ),
    )
    check(
        "fix2: scope check passed via probe",
        lambda: wait_for_event(
            "setup.scope_check_passed",
            lambda e: e.get("credentialType") == "GOOGLE_SHEETS_CRED",
        ),
    )

    # Open the Setup tab and read the provenance label.
    page.click('button:has-text("Setup")')
    page.wait_for_timeout(1500)

    def check_provenance_dom():
        locator = page.locator('[data-testid="suite-provenance"]')
        locator.wait_for(state="visible", timeout=15000)
        text = locator.inner_text()
        assert re.search(
            r"via your Google Drive credential \(drive-user@example\.com", text
        ), f"unexpected provenance text: {text!r}"

    check("fix2: setup panel shows provenance label with account", check_provenance_dom)
    check(
        "fix2: setup.suite_provenance_shown (setup_panel)",
        lambda: wait_for_event(
            "setup.suite_provenance_shown",
            lambda e: e.get("surface") == "setup_panel"
            and e.get("requiredCredentialType") == "GOOGLE_SHEETS_CRED",
        ),
    )
    page.screenshot(path=f"{ART}/smoke-setup-panel.png", full_page=False)

    # ── Credentials page: suite coverage line ───────────────────────────────
    page.goto(f"{STUDIO}/credentials", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)

    def check_coverage_dom():
        locator = page.locator('[data-testid="suite-coverage"]')
        locator.first.wait_for(state="visible", timeout=15000)
        texts = locator.all_inner_texts()
        assert any(
            "Also grants:" in t and "Google Sheets" in t and "Google Calendar" in t
            for t in texts
        ), f"unexpected coverage texts: {texts!r}"

    check("fix3: credentials page shows 'Also grants: Google Sheets, Google Calendar'", check_coverage_dom)
    check(
        "fix3: setup.suite_provenance_shown (credentials_page)",
        lambda: wait_for_event(
            "setup.suite_provenance_shown",
            lambda e: e.get("surface") == "credentials_page"
            and e.get("sourceCredentialType") == "GOOGLE_DRIVE_CRED",
        ),
    )
    page.screenshot(path=f"{ART}/smoke-credentials-page.png", full_page=False)

    browser.close()

print(json.dumps({"telemetry_events": [e["event"] for e in telemetry]}, indent=0))
if failures:
    print(f"\n{len(failures)} FAILURES")
    sys.exit(1)
print("\nALL CHECKS PASSED")
