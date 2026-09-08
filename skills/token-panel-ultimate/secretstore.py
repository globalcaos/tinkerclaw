"""
Token Panel — first-party secret store.

Every provider credential this dashboard uses is ITS OWN credential, issued to it by you.
Nothing here reads another application's credential store.

Storage order, best first:
  1. Linux  — libsecret via `secret-tool` (the value is passed on STDIN, never in argv).
  2. macOS  — the login Keychain through Security.framework (the value is passed as a
     pointer, never in argv). The `security` CLI is NOT used to write: its
     `add-generic-password -w <secret>` form puts the credential in this process's
     command line, where any local process enumerating processes can read it.
  3. Fallback — a 0600 file inside a 0700 directory, WITH A WARNING PRINTED EVERY RUN.

Lookup order when a collector asks for a secret:
  1. This store (keychain, or the warned 0600 fallback file).
  2. This tool's OWN namespaced variable, TOKEN_PANEL_<PROVIDER>_*, for CI and one-shot use.
  3. The generic provider variable (OPENAI_API_KEY, ANTHROPIC_ADMIN_API_KEY, ...) ONLY when
     you set TOKEN_PANEL_ALLOW_PROVIDER_ENV=1. Those variables belong to other tools; taking
     them silently would mean this dashboard runs on a credential nobody handed it.

Off switch: `clear_secret()` removes the secret from BOTH stores and prints the provider's
server-side revoke URL, because deleting a local copy is not revocation.

CLI:
    python3 secretstore.py --status
    python3 secretstore.py --login anthropic     # reads the secret from stdin
    python3 secretstore.py --logout anthropic
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

SERVICE = "token-panel-ultimate"

# Where the fallback lives when the machine has no keychain at all.
FALLBACK_DIR = Path.home() / ".openclaw" / "data" / "token-panel"
FALLBACK_FILE = FALLBACK_DIR / "credentials"

# Reading a GENERIC provider variable is opt-in. `env` below is ours and is always
# honoured; `also_env` belongs to other tools and is consulted only with this set to "1".
PROVIDER_ENV_OPT_IN = "TOKEN_PANEL_ALLOW_PROVIDER_ENV"

# A file we create ourselves inside FALLBACK_DIR. Nothing is ever deleted from a
# directory that does not carry it — see _assert_safe_to_delete().
MARKER_FILE = ".token-panel-store"

# Each provider: the env var we also accept, and the page where the credential is
# revoked SERVER-SIDE. Deleting the local copy does not revoke anything.
PROVIDERS = {
    "anthropic": {
        "env": "TOKEN_PANEL_ANTHROPIC_TOKEN",
        "also_env": "ANTHROPIC_ADMIN_API_KEY",
        "revoke_url": "https://console.anthropic.com/settings/keys",
        "revoke_note": "delete the API key there to revoke it server-side.",
    },
    "openai": {
        "env": "TOKEN_PANEL_OPENAI_KEY",
        "also_env": "OPENAI_API_KEY",
        "revoke_url": "https://platform.openai.com/api-keys",
        "revoke_note": "delete the API key there to revoke it server-side.",
    },
    "gemini": {
        "env": "TOKEN_PANEL_GEMINI_KEY",
        "also_env": "GEMINI_API_KEY",
        "revoke_url": "https://aistudio.google.com/apikey",
        "revoke_note": "delete the API key there to revoke it server-side.",
    },
    "manus": {
        "env": "TOKEN_PANEL_MANUS_KEY",
        "also_env": "MANUS_API_KEY",
        "revoke_url": "https://manus.im/",
        "revoke_note": "delete the key in your Manus account settings to revoke it server-side.",
    },
}

FALLBACK_WARNING = (
    "WARNING: no OS keychain was found (neither `secret-tool` nor macOS `security`), so this\n"
    "         credential is stored in a plain 0600 file at:\n"
    "           {path}\n"
    "         Any process running as your user can read it. Install libsecret to use the\n"
    "         keychain instead (Debian/Ubuntu: `sudo apt install libsecret-tools`), then\n"
    "         re-run the --login command."
)


def _have(binary: str) -> bool:
    return shutil.which(binary) is not None


def backend() -> str:
    """Which store will be used: 'libsecret', 'macos', or 'file'."""
    if sys.platform == "darwin" and _have("security"):
        return "macos"
    if _have("secret-tool"):
        return "libsecret"
    return "file"


def _warn_fallback() -> None:
    print(FALLBACK_WARNING.format(path=FALLBACK_FILE), file=sys.stderr)


# ---------------------------------------------------------------------------
# macOS keychain, written through Security.framework
#
# The `security` CLI has no stdin path for a generic password: the only scriptable
# form is `add-generic-password -w <secret>`, which places the credential in argv
# where `ps`, /proc-equivalents and process-monitoring agents can read it. The
# framework entry points below take the bytes as a pointer instead, so the secret
# never becomes a command-line argument. Reads and deletes still use the CLI —
# neither of those passes the secret in argv.
# ---------------------------------------------------------------------------

def _macos_keychain_store(account: str, value: str) -> bool:
    """Store `value` in the login keychain. True if it landed, False to fall through."""
    import ctypes
    import ctypes.util

    libpath = ctypes.util.find_library("Security")
    if not libpath:
        return False
    try:
        sec = ctypes.CDLL(libpath)
    except OSError:
        return False

    u32 = ctypes.c_uint32
    vp = ctypes.c_void_p

    try:
        sec.SecKeychainFindGenericPassword.argtypes = [
            vp, u32, ctypes.c_char_p, u32, ctypes.c_char_p,
            ctypes.POINTER(u32), ctypes.POINTER(vp), ctypes.POINTER(vp),
        ]
        sec.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        sec.SecKeychainAddGenericPassword.argtypes = [
            vp, u32, ctypes.c_char_p, u32, ctypes.c_char_p,
            u32, ctypes.c_char_p, ctypes.POINTER(vp),
        ]
        sec.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        sec.SecKeychainItemModifyAttributesAndData.argtypes = [vp, vp, u32, ctypes.c_char_p]
        sec.SecKeychainItemModifyAttributesAndData.restype = ctypes.c_int32
        sec.SecKeychainItemFreeContent.argtypes = [vp, vp]
        sec.SecKeychainItemFreeContent.restype = ctypes.c_int32
    except AttributeError:
        return False

    service = SERVICE.encode()
    acct = account.encode()
    secret = value.encode()

    length = u32()
    data = vp()
    item = vp()

    # An existing entry must be MODIFIED; SecKeychainAddGenericPassword would
    # return errSecDuplicateItem and leave the stale credential in place.
    found = sec.SecKeychainFindGenericPassword(
        None, len(service), service, len(acct), acct,
        ctypes.byref(length), ctypes.byref(data), ctypes.byref(item),
    )
    if found == 0:
        sec.SecKeychainItemFreeContent(None, data)
        return sec.SecKeychainItemModifyAttributesAndData(
            item, None, len(secret), secret
        ) == 0

    return sec.SecKeychainAddGenericPassword(
        None, len(service), service, len(acct), acct,
        len(secret), secret, None,
    ) == 0


# ---------------------------------------------------------------------------
# Fallback file (0600 inside a 0700 directory)
# ---------------------------------------------------------------------------

def _read_fallback() -> dict:
    if not FALLBACK_FILE.exists():
        return {}
    st = FALLBACK_FILE.stat()
    if st.st_uid != os.getuid():
        raise PermissionError(f"{FALLBACK_FILE} is not owned by you — refusing to read it.")
    if st.st_mode & 0o077:
        raise PermissionError(
            f"{FALLBACK_FILE} is group/world accessible. Run: chmod 600 {FALLBACK_FILE}"
        )
    out = {}
    for line in FALLBACK_FILE.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _write_fallback(entries: dict) -> None:
    FALLBACK_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(FALLBACK_DIR, 0o700)
    # Proof that this directory is ours. --logout refuses to unlink anything that is
    # not sitting next to a marker this tool wrote itself.
    marker = FALLBACK_DIR / MARKER_FILE
    if not marker.exists():
        fd = os.open(str(marker), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"{SERVICE} credential store — do not edit by hand.\n")
    body = "".join(f"{k}={v}\n" for k, v in sorted(entries.items()))
    fd = os.open(str(FALLBACK_FILE), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    os.chmod(FALLBACK_FILE, 0o600)


def _assert_safe_to_delete(path: Path) -> None:
    """Refuse to unlink anything that is not demonstrably our own credential file.

    This is the only unlink in the skill. It runs on a path derived from $HOME, but a
    derived path is not a verified one: a symlink or a swapped directory would make
    --logout delete something the user cares about. Every condition below must hold.
    """
    if not path.is_absolute():
        raise ValueError(f"refusing to delete a relative path: {path}")

    home = Path.home().resolve()
    try:
        resolved_parent = path.parent.resolve(strict=True)
    except FileNotFoundError:
        raise ValueError(f"refusing to delete: {path.parent} does not exist")
    if home != resolved_parent and home not in resolved_parent.parents:
        raise ValueError(f"refusing to delete outside your home directory: {path}")

    if path.is_symlink():
        raise ValueError(f"refusing to delete a symlink: {path}")
    if not path.is_file():
        raise ValueError(f"refusing to delete a non-regular file: {path}")

    st = path.stat()
    if st.st_uid != os.getuid():
        raise PermissionError(f"refusing to delete a file you do not own: {path}")

    marker = path.parent / MARKER_FILE
    if not marker.is_file() or marker.is_symlink():
        raise ValueError(
            f"refusing to delete {path}: {marker} is missing, so this directory was "
            f"not created by {SERVICE}."
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def set_secret(provider: str, value: str) -> str:
    """Store a secret for `provider`. Returns the backend actually used."""
    if provider not in PROVIDERS:
        raise KeyError(f"unknown provider: {provider}")

    kind = backend()
    if kind == "libsecret":
        r = subprocess.run(
            ["secret-tool", "store", f"--label={SERVICE} {provider}",
             "service", SERVICE, "account", provider],
            input=value, text=True,
        )
        if r.returncode == 0:
            return "keychain:libsecret"
    elif kind == "macos":
        # Security.framework, not `security -w`: the secret is passed by pointer and
        # never appears in this process's argv. If the framework call fails we fall
        # through to the WARNED 0600 file rather than reaching for the CLI form.
        if _macos_keychain_store(provider, value):
            return "keychain:macos"

    entries = _read_fallback()
    entries[provider] = value
    _write_fallback(entries)
    _warn_fallback()
    return "file"


def get_secret(provider: str) -> tuple[str | None, str | None]:
    """Return (secret, source) for `provider`, or (None, None) if unset.

    Store first, then the provider's environment variables.
    """
    if provider not in PROVIDERS:
        raise KeyError(f"unknown provider: {provider}")

    kind = backend()
    if kind == "libsecret":
        r = subprocess.run(
            ["secret-tool", "lookup", "service", SERVICE, "account", provider],
            capture_output=True, text=True,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip(), "keychain:libsecret"
    elif kind == "macos":
        r = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE, "-a", provider, "-w"],
            capture_output=True, text=True,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip(), "keychain:macos"

    if FALLBACK_FILE.exists():
        value = _read_fallback().get(provider)
        if value:
            _warn_fallback()
            return value, "file"

    spec = PROVIDERS[provider]

    # Ours, always honoured — the name says who it belongs to.
    value = os.environ.get(spec["env"])
    if value:
        return value, f"env:{spec['env']}"

    # Someone else's. OPENAI_API_KEY was exported for whatever tool the user set it up
    # for, not for this dashboard; using it silently would spend a credential nobody
    # pointed at us. Off unless explicitly switched on.
    if os.environ.get(PROVIDER_ENV_OPT_IN) == "1":
        value = os.environ.get(spec["also_env"])
        if value:
            print(
                f"NOTE: using {spec['also_env']} from the environment because "
                f"{PROVIDER_ENV_OPT_IN}=1. That variable belongs to other tools too.",
                file=sys.stderr,
            )
            return value, f"env:{spec['also_env']}"

    return None, None


def clear_secret(provider: str) -> list[str]:
    """The off switch. Remove the secret from BOTH stores and print the revoke URL.

    Returns the list of stores it was actually removed from.
    """
    if provider not in PROVIDERS:
        raise KeyError(f"unknown provider: {provider}")

    cleared = []

    if _have("secret-tool"):
        found = subprocess.run(
            ["secret-tool", "lookup", "service", SERVICE, "account", provider],
            capture_output=True, text=True,
        )
        if found.returncode == 0 and found.stdout.strip():
            r = subprocess.run(
                ["secret-tool", "clear", "service", SERVICE, "account", provider],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if r.returncode == 0:
                cleared.append("keychain:libsecret")

    if sys.platform == "darwin" and _have("security"):
        r = subprocess.run(
            ["security", "delete-generic-password", "-s", SERVICE, "-a", provider],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if r.returncode == 0:
            cleared.append("keychain:macos")

    entries = _read_fallback()
    if provider in entries:
        del entries[provider]
        if entries:
            _write_fallback(entries)
        else:
            _assert_safe_to_delete(FALLBACK_FILE)
            FALLBACK_FILE.unlink()
        cleared.append(f"file:{FALLBACK_FILE}")

    spec = PROVIDERS[provider]
    print(f"Local copies removed: {', '.join(cleared) if cleared else 'none were stored'}")
    for env_name in (spec["env"], spec["also_env"]):
        if os.environ.get(env_name):
            print(f"NOTE: {env_name} is still set in this environment — unset it too.")
    print(
        f"\nThis only deleted local copies. To REVOKE the credential server-side, open:\n"
        f"  {spec['revoke_url']}\n"
        f"  ({spec['revoke_note']})"
    )
    return cleared


def status() -> None:
    print(f"backend: {backend()}")
    if backend() == "file":
        print(f"         (no OS keychain; fallback file is {FALLBACK_FILE})")
    for provider in sorted(PROVIDERS):
        value, source = get_secret(provider)
        print(f"  {provider:<10} {'set   via ' + source if value else 'not set'}")


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Token Panel credential store")
    ap.add_argument("--status", action="store_true", help="Show which providers have a stored credential")
    ap.add_argument("--login", metavar="PROVIDER", help="Store a credential (read from stdin)")
    ap.add_argument("--logout", metavar="PROVIDER", help="Remove a credential from every local store")
    args = ap.parse_args()

    if args.login:
        if args.login not in PROVIDERS:
            print(f"Unknown provider: {args.login}. Known: {', '.join(sorted(PROVIDERS))}", file=sys.stderr)
            return 1
        if sys.stdin.isatty():
            print(f"Paste the {args.login} credential, then press Ctrl-D:", file=sys.stderr)
        value = sys.stdin.read().strip()
        if not value:
            print("Nothing read from stdin; aborted.", file=sys.stderr)
            return 1
        where = set_secret(args.login, value)
        print(f"Stored {args.login} credential in: {where}")
        return 0

    if args.logout:
        if args.logout not in PROVIDERS:
            print(f"Unknown provider: {args.logout}. Known: {', '.join(sorted(PROVIDERS))}", file=sys.stderr)
            return 1
        clear_secret(args.logout)
        return 0

    status()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
