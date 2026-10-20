#!/usr/bin/env python3
"""Headless screenshots of the locally built site. Usage: python3 tools/screenshot.py [base_url]
Serve _site first: python3 -m http.server 8765 -d _site"""
import sys, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
out = Path(__file__).resolve().parent.parent / "screens"
out.mkdir(exist_ok=True)
chrome = shutil.which("google-chrome") or shutil.which("chromium")
shots = [
    ("home-desktop.png", "", {"width": 1440, "height": 900}, True),
    ("home-desktop-fold.png", "", {"width": 1440, "height": 900}, False),
    ("home-mobile.png", "", {"width": 390, "height": 844}, True),
    ("home-conference-day-preview.png", "?now=2026-12-10T05:20:00Z", {"width": 1440, "height": 900}, False),
    ("proceedings.png", "proceedings.html", {"width": 1440, "height": 900}, True),
]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=chrome, args=["--no-sandbox"]) if chrome else p.chromium.launch()
    for name, path, vp, full in shots:
        pg = b.new_page(viewport=vp, device_scale_factor=2 if vp["width"] < 600 else 1)
        pg.goto(base + path, wait_until="networkidle")
        pg.wait_for_timeout(600)
        if "conference-day" in name:
            pg.evaluate("window.scrollTo(0, document.querySelector('#agenda').offsetTop - 72)")
            pg.wait_for_timeout(300)
        pg.screenshot(path=str(out / name), full_page=full)
        print("saved", out / name)
    b.close()
