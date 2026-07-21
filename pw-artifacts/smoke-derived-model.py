#!/usr/bin/env python3
"""Browser smoke for the derived-credential model (parts 1-3).

Two server modes drive two scenario sets:

MODE=fallback (API WITHOUT the Google stub — identity unresolvable, probe dead):
  1. The Sheets step binds through the STORED Drive-derived record
     (setup.suite_binding_proposed carries hasDerivedRecord=true) and the setup
     panel shows the provenance label sourced from the stored record.
  2. Scope check falls back to the stored grant (source=stored) and still
     verifies — the persisted record equals what the check reads.
  3. gmailAccountEmail references the bound credential by NAME (email unknown:
     credential predates identity scopes) — never blank — and the inline
     "reconnect to show the email" affordance renders.
  4. Credentials page "Also grants:" line reads the STORED records.

MODE=identity (API WITH pw-artifacts/google-stub.preload.ts):
  5. gmailAccountEmail autopopulates with the BACKFILLED email (existing
     behavior preserved) and no reconnect affordance shows.
  6. Suite binding verifies via live probe (source=probe) with the provenance
     label carrying the account email.
"""
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

STUDIO = "http://localhost:3511"
FLOW_ID = 1
MODE = os.environ.get("MODE", "fallback")
ART = "/home/unix/bubblelab-derived/pw-artifacts"

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
    seen = sorted({e.get("event") for e in telemetry})
    raise AssertionError(f"telemetry event not seen: {name}; saw {seen}")


failures = []


def check(label, fn):
    try:
        fn()
        print(f"PASS [{MODE}] {label}")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"[{MODE}] {label}: {exc}")
        print(f"FAIL [{MODE}] {label}: {exc}")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.on("console", on_console)

    page.goto(f"{STUDIO}/flow/{FLOW_ID}", wait_until="domcontentloaded")
    page.wait_for_timeout(4000)

    check(
        "suite binding proposed FROM the stored derived record (hasDerivedRecord=true)",
        lambda: wait_for_event(
            "setup.suite_binding_proposed",
            lambda e: e.get("requiredCredentialType") == "GOOGLE_SHEETS_CRED"
            and e.get("sourceCredentialType") == "GOOGLE_DRIVE_CRED"
            and e.get("hasDerivedRecord") is True,
        ),
    )
    expected_source = "probe" if MODE == "identity" else "stored"
    check(
        f"scope check passed (source={expected_source})",
        lambda: wait_for_event(
            "setup.scope_check_passed",
            lambda e: e.get("credentialType") == "GOOGLE_SHEETS_CRED"
            and e.get("source") == expected_source,
            # fallback mode probes real Google with a fake token; the dead
            # outbound route can stall the fetch well past 30s before the
            # stored-grant fallback answers.
            timeout_s=120,
        ),
    )

    if MODE == "identity":
        check(
            "gmailAccountEmail autopopulated with backfilled EMAIL (regression)",
            lambda: wait_for_event(
                "setup.field_autopopulated",
                lambda e: e.get("field") == "gmailAccountEmail"
                and e.get("value") == "gmail-user@example.com"
                and e.get("source") == "oauth_account_email",
            ),
        )

        def check_no_affordance():
            locator = page.locator(
                '[data-testid="account-field-reconnect-gmailAccountEmail"]'
            )
            assert locator.count() == 0, "reconnect affordance must not render"

        check("no reconnect affordance when the email is known", check_no_affordance)
    else:
        check(
            "gmailAccountEmail references the bound credential by NAME (never blank)",
            lambda: wait_for_event(
                "setup.field_autopopulated",
                lambda e: e.get("field") == "gmailAccountEmail"
                and e.get("value") == "Legacy Gmail"
                and e.get("source") == "credential_name",
            ),
        )

        def check_affordance():
            locator = page.locator(
                '[data-testid="account-field-reconnect-gmailAccountEmail"]'
            )
            locator.wait_for(state="visible", timeout=15000)
            text = locator.inner_text()
            assert "Reconnect to show the email" in text, f"affordance text: {text!r}"

        check("inline reconnect-to-grant-email affordance renders", check_affordance)

    # Setup tab: provenance label sourced from the stored record.
    page.click('button:has-text("Setup")')
    page.wait_for_timeout(1500)

    account = (
        "drive-user@example\\.com" if MODE == "identity" else "Legacy Drive"
    )

    def check_provenance_dom():
        locator = page.locator('[data-testid="suite-provenance"]')
        locator.wait_for(state="visible", timeout=15000)
        text = locator.inner_text()
        assert re.search(
            rf"via your Google Drive credential \({account}", text
        ), f"unexpected provenance text: {text!r}"

    check("setup panel shows 'via your Google Drive credential'", check_provenance_dom)
    page.screenshot(path=f"{ART}/smoke-derived-setup-{MODE}.png", full_page=False)

    # Credentials page: coverage line from the STORED records.
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

    check(
        "credentials page 'Also grants:' reads the stored records",
        check_coverage_dom,
    )
    page.screenshot(path=f"{ART}/smoke-derived-credentials-{MODE}.png", full_page=False)

    browser.close()

print(json.dumps({"mode": MODE, "telemetry_events": [e["event"] for e in telemetry]}))
if failures:
    print(f"\n{len(failures)} FAILURES")
    sys.exit(1)
print(f"\nALL {MODE.upper()} CHECKS PASSED")
