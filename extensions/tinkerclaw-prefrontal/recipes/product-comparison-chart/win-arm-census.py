#!/usr/bin/env python3
"""Will the programs of this Windows install run on an ARM PC? One read-only census.

Usage:
  python3 -I win-arm-census.py <windows-root>
  ssh <host> 'python3 - <windows-root>' < win-arm-census.py    # disk mounted on another machine

<windows-root> is the folder that holds "Program Files" and "Windows": /mnt/c inside WSL, or the
mount point of a Windows disk. Windows on ARM translates x86/x64 user-mode code (Prism) and never
translates a kernel driver. So for every program folder the census counts the PE files by
processor (x86, x64, arm64) and finds the drivers it depends on: the .sys files inside the folder,
plus the non-Microsoft drivers in Windows/System32/drivers whose company name or file name matches
the folder (VPN clients and packet capture install theirs there). Drivers that Windows ships itself
(named by its own INF files) are left out. On an Intel PC nearly every program is Intel code;
whether its vendor ships an ARM build is a separate check, read from the vendor's current release
notes. It opens files and writes nothing.
"""
import os
import re
import struct
import sys
from collections import Counter

MACHINE = {0x14C: "x86", 0x8664: "x64", 0xAA64: "arm64", 0xA641: "arm64ec", 0x1C4: "arm"}
ARM = {"arm64", "arm64ec", "arm"}
SHARED = {"common files"}  # one folder, many vendors: each subfolder counts as a program
NOT_A_NAME = {"inc", "corp", "corporation", "technology", "technologies", "the", "project",
              "ltd", "limited", "company", "systems", "software", "gmbh", "windows", "provider"}
# Driver makers whose name differs from the folder of the program that needs the driver.
ALIASES = {"riverbed": {"winpcap", "npcap", "wireshark"}, "cace": {"winpcap", "wireshark"},
           "wireguard": {"wireguard", "openvpn", "tailscale"}}


def machine(path):
    try:
        with open(path, "rb") as f:
            if f.read(2) != b"MZ":
                return None
            f.seek(0x3C)
            f.seek(struct.unpack("<I", f.read(4))[0])
            if f.read(4) != b"PE\0\0":
                return None
            return MACHINE.get(struct.unpack("<H", f.read(2))[0], "other")
    except (OSError, struct.error):
        return None


def company(path):
    key = "CompanyName".encode("utf-16-le")
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return "?"
    i = data.rfind(key)
    if i < 0:
        return "?"
    text = data[i + len(key):i + len(key) + 200].decode("utf-16-le", "ignore")
    parts = [p.strip() for p in text.split("\x00") if p.strip()]
    return parts[0] if parts else "?"


def text_of(path):
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    return raw.decode("utf-16", "ignore") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("latin-1", "ignore")


def inbox_drivers(root):
    """.sys names in Windows' own INF files (oem*.inf are the ones third parties installed)."""
    inf, names = os.path.join(root, "Windows", "INF"), set()
    if os.path.isdir(inf):
        for f in os.listdir(inf):
            low = f.lower()
            if low.endswith(".inf") and not low.startswith("oem"):
                names.update(m.lower() for m in re.findall(r"[\w\-]+\.sys", text_of(os.path.join(inf, f))))
    return names


def program_folders(root):
    for pf in ("Program Files", "Program Files (x86)"):
        base = os.path.join(root, pf)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            top = os.path.join(base, name)
            if not os.path.isdir(top):
                continue
            if name.lower() in SHARED:
                for sub in sorted(os.listdir(top)):
                    if os.path.isdir(os.path.join(top, sub)):
                        yield f"{pf}/{name}/{sub}", sub, os.path.join(top, sub)
            else:
                yield f"{pf}/{name}", name, top


def keys_for(driver, maker):
    keys = {w for w in re.findall(r"[a-z0-9]{4,}", maker.lower()) if w not in NOT_A_NAME}
    for word in list(keys):
        keys |= ALIASES.get(word, set())
    stem = os.path.splitext(driver)[0].lower()
    if len(stem) >= 4:
        keys.add(stem[:4])
    return keys


def census(root):
    rows = []
    for label, name, top in program_folders(root):
        arch, drivers = Counter(), set()
        for dirpath, _, files in os.walk(top):
            for f in files:
                low = f.lower()
                if low.endswith((".exe", ".dll", ".sys")):
                    m = machine(os.path.join(dirpath, f))
                    if m:
                        arch[m] += 1
                    if low.endswith(".sys"):
                        drivers.add(f)
        if arch:
            rows.append({"label": label, "name": name.lower(), "arch": arch, "drivers": drivers})
    inbox, unmatched = inbox_drivers(root), []
    ddir = os.path.join(root, "Windows", "System32", "drivers")
    for f in sorted(os.listdir(ddir)) if os.path.isdir(ddir) else []:
        path = os.path.join(ddir, f)
        if not f.lower().endswith(".sys") or f.lower() in inbox or not os.path.isfile(path):
            continue
        maker = company(path)
        if "microsoft" in maker.lower():
            continue
        keys = keys_for(f, maker)
        owners = [r for r in rows if any(k in r["name"] for k in keys)]
        for r in owners:
            r["drivers"].add(f)
        if not owners:
            unmatched.append(f"{f} ({maker})")
    groups = {"stops": [], "translated": [], "arm": []}
    for r in rows:
        line = r["label"] + ": " + ", ".join(f"{k} {v}" for k, v in r["arch"].most_common())
        if r["drivers"]:
            line += " | drivers: " + ", ".join(sorted(r["drivers"])[:8])
        group = "arm" if ARM & set(r["arch"]) else "stops" if r["drivers"] else "translated"
        groups[group].append(line)
    for title, lines in (
        ("STOPS on ARM unless the vendor ships an ARM build: Intel-only code that needs a driver", groups["stops"]),
        ("RUNS TRANSLATED on ARM: Intel-only code, no driver found", groups["translated"]),
        ("HAS ARM CODE already (any driver it lists must be ARM64 too)", groups["arm"]),
        ("OTHER NON-MICROSOFT DRIVERS, no program folder matched (hardware ones stay with the old PC)", unmatched),
    ):
        print(f"== {title} ({len(lines)})")
        for line in lines:
            print("  " + line)


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit("usage: win-arm-census.py <windows-root>   (the folder holding 'Program Files' and 'Windows')")
    census(sys.argv[1])
