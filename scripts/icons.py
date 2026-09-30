"""Render the shared kiln mark for the README and Android launcher."""

from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
source = root / "assets/icon.svg"
paths = ET.parse(source).getroot().findall("{http://www.w3.org/2000/svg}path")
android = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", android)
vector = ET.Element("vector", {
    f"{{{android}}}width": "108dp", f"{{{android}}}height": "108dp",
    f"{{{android}}}viewportWidth": "108", f"{{{android}}}viewportHeight": "108",
})
foreground = ET.SubElement(vector, "group", {f"{{{android}}}pivotX": "54", f"{{{android}}}pivotY": "54", f"{{{android}}}scaleX": "0.85", f"{{{android}}}scaleY": "0.85"})
for path in paths[1:]:
    ET.SubElement(foreground, "path", {
        f"{{{android}}}fillColor": path.attrib["fill"],
        f"{{{android}}}pathData": path.attrib["d"],
    })
ET.indent(vector)
ET.ElementTree(vector).write(root / "android/app/src/main/res/drawable/icon.xml", encoding="unicode")
subprocess.run(["rsvg-convert", "-w", "512", "-h", "512", "-o", str(root / "assets/icon.png"), str(source)], check=True)
