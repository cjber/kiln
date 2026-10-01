"""Capture seeded production UI on a dedicated emulator, never on a paired phone."""

import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
sdk = Path(os.environ["ANDROID_HOME"])
adb = str(sdk / "platform-tools/adb")
serial = "emulator-5560"
avd = "kiln-screenshots"


def run(*args: str, **kwargs) -> str:
    return subprocess.check_output(args, text=True, **kwargs).strip()


def device(*args: str) -> str:
    return run(adb, "-s", serial, *args)


subprocess.run([str(root / "android/gradlew"), "-p", str(root / "android"), "assembleDebug"], check=True)
emulator = None
log = None
try:
    devices = run(adb, "devices")
    if f"{serial}\t" not in devices:
        available = run(str(sdk / "emulator/emulator"), "-list-avds").splitlines()
        if avd not in available:
            subprocess.run([
                str(sdk / "cmdline-tools/latest/bin/avdmanager"), "create", "avd",
                "-n", avd, "-k", "system-images;android-35;google_apis;x86_64", "-d", "pixel_7",
            ], input="no\n", text=True, check=True)
        log = (root / "android/.gradle/screenshot-emulator.log").open("w")
        emulator = subprocess.Popen([
            str(sdk / "emulator/emulator"), "-avd", avd, "-port", "5560",
            "-no-window", "-no-audio", "-no-snapshot", "-gpu", "swiftshader", "-timezone", "UTC",
        ], stdout=log, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            if device("shell", "getprop", "sys.boot_completed") == "1":
                break
        except subprocess.CalledProcessError:
            pass
        time.sleep(1)
    else:
        raise RuntimeError("Screenshot emulator did not boot within three minutes")
    if device("emu", "avd", "name").splitlines()[0] != avd:
        raise RuntimeError("Port 5560 belongs to another emulator; refusing to change it")
    device("shell", "input", "keyevent", "82")
    device("shell", "settings", "put", "secure", "immersive_mode_confirmations", "confirmed")
    device("shell", "settings", "put", "global", "window_animation_scale", "0")
    device("shell", "settings", "put", "global", "transition_animation_scale", "0")
    device("shell", "settings", "put", "global", "animator_duration_scale", "0")
    device("install", "-r", str(root / "android/app/build/outputs/apk/debug/app-debug.apk"))
    for screen, marker in [("list", "Cache map tiles"), ("pair", "Pairing invitation"), ("handoff", "Open in Claude")]:
        device("shell", "am", "force-stop", "com.cjber.kiln")
        device("shell", "am", "start", "-W", "-n", "com.cjber.kiln/.ScreenshotActivity", "--es", "screen", screen)
        for _ in range(15):
            device("shell", "uiautomator", "dump", "/sdcard/kiln-screenshot.xml")
            hierarchy = device("shell", "cat", "/sdcard/kiln-screenshot.xml")
            if marker in hierarchy:
                break
            for node in ET.fromstring(hierarchy).iter("node"):
                if node.get("package") == "android" and node.get("resource-id") in {"android:id/ok", "android:id/aerr_close"}:
                    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
                    device("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
            time.sleep(1)
        else:
            print(device("shell", "cat", "/sdcard/kiln-screenshot.xml"))
            print(device("logcat", "-d", "-s", "AndroidRuntime:E", "KilnScreenshot:I"))
            raise RuntimeError(f"Seeded {screen} screen never became visible")
        output = root / "assets" / {"list": "android-list.png", "pair": "android-pairing.png", "handoff": "android-handoff.png"}[screen]
        output.write_bytes(subprocess.check_output([adb, "-s", serial, "exec-out", "screencap", "-p"]))
        print(output.relative_to(root))
finally:
    if emulator is not None:
        emulator.terminate()
        emulator.wait(timeout=30)
    if log is not None:
        log.close()
