---
schema: "kit/1.0"
slug: "windows-vm-gpu-tailscale-workstation"
title: "Windows VM GPU + Tailscale workstation"
summary: "Turn a Linux-hosted Windows VM into a remotely usable GPU workstation: inspect the real graphics topology, reserve a discrete GPU with VFIO, preserve a safe non-passthrough boot path, attach the GPU to QEMU, choose a GPU-aware remote desktop, and expose only the required LAN license server through a narrowly scoped Tailscale subnet route."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "gpu passthrough",
    "vfio",
    "windows vm gpu",
    "qemu gpu passthrough",
    "solidworks vm",
    "remote solidworks",
    "tailscale license manager",
    "tailscale subnet router",
    "remote gpu workstation",
    "pci passthrough",
    "windows rtx vm",
    "give my windows vm access to the gpu",
    "run solidworks remotely from a vm",
    "pass the nvidia gpu through to windows",
    "reach a lan license server through tailscale",
    "set up a remote windows gpu workstation",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
    - [6]
    - [7]
    - [8]
  notes: |
    Run serially. Each stage changes the assumptions and safety conditions of the next; parallel edits to boot, VM topology, and routing create failures that are difficult to attribute.
---

# Windows VM GPU + Tailscale workstation

> Turn a Linux-hosted Windows VM into a remotely usable GPU workstation: inspect the real graphics topology, reserve a discrete GPU with VFIO, preserve a safe non-passthrough boot path, attach the GPU to QEMU, choose a GPU-aware remote desktop, and expose only the required LAN license server through a narrowly scoped Tailscale subnet route.

## Goal

Produce a reversible, verified workstation path in which Linux remains operable on a fallback GPU, Windows owns the intended discrete GPU, remote graphics actually use that GPU, and the guest reaches only the required license server through Tailscale.

## When to Use

- A Linux host runs Windows under QEMU/KVM and Windows needs near-native discrete-GPU performance.
- SolidWorks or another licensed Windows application must run remotely while its license manager remains on a private LAN.
- A Tailscale node on that LAN can act as a narrowly scoped subnet router.
- The requester says to reproduce an existing remote workstation setup on another machine.

## Steps

### 1. Observe every path before choosing one

**Tools:** read, exec
**Done when:** The host GPU, display, VM, network, Tailscale, and license-server topology is recorded from live evidence.

Inspect before editing. Enumerate all GPUs and functions with `lspci -nnk`; identify the active renderer and connected outputs with `glxinfo -B` and `xrandr --listproviders`; inspect CPU virtualization, Secure Boot, kernel command line, IOMMU groups, reset methods, and the current drivers. Capture the running QEMU command and read the launcher scripts rather than reconstructing them from process output alone. Enumerate every network interface, address, route, gateway, and Tailscale route advertisement. Resolve the license manager's IP and both its manager and vendor-daemon ports from the server configuration; do not infer them from folklore. The output is a topology map plus explicit unknowns. If there is no independent host display GPU, stop and present alternatives rather than making the host blind.

### 2. Prove VFIO feasibility and define rollback

**Tools:** read, exec
**Done when:** GPU isolation is feasible, every function to pass is known, and a tested rollback path exists on paper before boot files change.

Confirm the host can render without the target GPU. Check that the GPU and companion functions such as HDMI audio are isolated well enough for VFIO, and record their PCI addresses and vendor:device IDs. Check reset support and laptop-specific risks such as Optimus wiring, firmware-owned devices, external ports tied to the discrete GPU, and vBIOS requirements. Prefer a separate boot mode that binds the discrete GPU to `vfio-pci` while preserving the existing normal-Linux mode. State exactly how to return to the normal entry if the VFIO boot loses graphics or networking. Do not treat visible IOMMU groups, a successful module load, or an inactive display flag as proof that guest passthrough will work.

### 3. Quiesce Windows and protect its state

**Tools:** read, exec
**Done when:** Windows is cleanly shut down, host-mounted guest storage is absent, incompatible frozen state is handled, and the original VM topology is preserved.

Shut Windows down through the guest or QMP; never kill QEMU while it owns a physical Windows disk. Verify its disk is not mounted by Linux. Snapshot or copy only the small mutable configuration artifacts needed for rollback, not the raw guest disk unless requested. Treat QEMU migration/freeze images as topology-specific: a frozen state created with QXL cannot resume after VFIO devices are added. Preserve the exact existing launcher as the known-good non-GPU path and create a separate GPU mode rather than silently replacing it. Any discard of frozen state requires explicit owner approval because it is destructive.

### 4. Create the VFIO boot mode

**Tools:** read, exec
**Done when:** A separate boot path reserves all target GPU functions for vfio-pci and the normal Linux path remains selectable.

Configure the GPU and every required companion function for early `vfio-pci` binding using the distribution's supported initramfs and bootloader mechanism. Keep this isolated to a named VM/VFIO boot entry when practical; do not globally blacklist the discrete GPU if the owner still needs it in normal Linux. Rebuild the relevant initramfs or boot configuration, inspect the generated artifacts, and show the exact pending reboot. Rebooting is an external, disruptive action: ask before doing it. After boot, verify the target functions are owned by `vfio-pci`, the host desktop renders on the fallback GPU, and expected monitors and remote access remain usable. A config file containing the IDs is not green evidence.

### 5. Attach the real GPU without breaking the known-good VM

**Tools:** read, exec
**Done when:** The GPU-mode QEMU command passes every required PCI function while the original virtual-display mode remains available.

Add the GPU and audio functions to a dedicated QEMU GPU mode using Q35, OVMF, KVM, and `vfio-pci`. Preserve a temporary virtual display during driver installation unless the hardware path has already been proven. Add a ROM file only when direct evidence shows the laptop firmware leaves the GPU unusable without one. Keep device topology stable across freeze/resume and record the GPU flag in any exact-flags marker. Start with a clean guest shutdown, then verify QEMU owns the VFIO group and the host no longer has a native driver bound to those endpoint functions. Never weaken disk-safety guards to make GPU launch convenient.

### 6. Make Windows and the remote surface use the GPU

**Tools:** exec
**Done when:** Windows reports the physical GPU healthy, a real workload raises GPU activity, and the chosen remote session displays that accelerated workload.

Install the correct Windows GPU driver and verify Device Manager reports no error. Confirm the physical GPU from inside Windows, then run a representative graphics workload and observe utilization rather than trusting device presence. Choose a GPU-aware remote surface such as Parsec or Sunshine/Moonlight when interactive CAD performance matters. RDP is acceptable only after proving that the intended SolidWorks version uses the passed GPU in that RDP session; a GPU visible in Device Manager does not prove the application is rendering on it. If the encoder or display stack requires an active output, use a virtual display or dummy plug only after observing that specific failure.

### 7. Join Windows to Tailscale and expose only the license server

**Tools:** exec, browser
**Done when:** Windows is in the intended tailnet and receives an approved route only to the required license-server address or smallest justified subnet.

Install Tailscale in Windows and confirm it joined the intended account. Adding the guest to Tailscale reaches other Tailscale nodes but does not automatically reach LAN servers behind them. On the selected LAN gateway node, verify IP forwarding and current advertised routes, then advertise the license server as a `/32` whenever possible. Approve the route in the Tailscale admin console and constrain it with tailnet grants/ACLs to the Windows VM and required ports. Prefer a `/32` over an entire `/24`: home networks commonly overlap private LAN ranges, and broad advertisement grants access unrelated to licensing. Preserve Tailscale's subnet SNAT unless there is a demonstrated need for original-source addresses; SNAT avoids adding a return route to the license server.

### 8. Prove the SolidWorks license path

**Tools:** exec
**Done when:** The Windows guest reaches every configured license-manager port through the advertised route and SolidWorks obtains and releases a real license.

From Windows, inspect the installed route and test TCP connectivity to the manager port and the configured vendor-daemon port. SolidNetWork commonly uses manager port 25734, but the server's live configuration is authoritative; the vendor daemon must use a fixed, allowed port when a firewall is involved. Configure SolidWorks with the server IP or a deliberately resolved hostname, because MagicDNS does not resolve arbitrary private-LAN names. Launch SolidWorks, verify a license is checked out in the manager, close it, and verify release. A successful ping, access to the gateway node, or an open 25734 alone is not end-to-end proof.

### 9. Verify the whole experience and document both modes

**Tools:** read, exec
**Done when:** Normal Linux, Windows GPU mode, remote CAD, licensing, route scope, and rollback have each been exercised at the surface the owner will use.

Test the owner-visible sequence: select the VFIO mode, launch Windows through its normal icon or command, connect from the remote machine, run a SolidWorks graphics workload, obtain the LAN license, and disconnect cleanly. Observe GPU load in Windows, verify Linux remains reachable, inspect Tailscale routes to ensure no unintended LAN exposure, and verify the normal Linux boot still restores native GPU ownership. Record exact machine-specific IDs, paths, ports, and rollback commands in private operational memory, not in this reusable recipe. Distinguish written, booted, guest-visible, accelerated, remotely visible, and licensed; claim only the highest layer directly observed.

## Constraints

- Observe the current machine every run; never reuse PCI IDs, interface names, IOMMU groups, ports, or launcher paths from memory.
- Preserve a known-good non-passthrough boot and VM launch path until the accelerated path is verified end to end.
- Do not advertise a whole private subnet when a license-server /32 satisfies the requirement.
- Never discard frozen VM state, reboot, alter firmware, or approve broad tailnet access without explicit owner approval.
- A device present in Windows is not proof of acceleration; observe application GPU load in the actual remote session.
- A reachable Tailscale gateway is not proof of licensing; observe a real checkout and release from the license manager.
- Keep credentials, auth keys, license-server identities, and machine-specific secrets out of the recipe.

## Safety Notes

- Passing through the only working display GPU can leave the host locally blind; establish remote recovery and a fallback boot first.
- Raw physical guest disks can be corrupted by simultaneous host mounting, forced QEMU termination, or resuming stale frozen RAM against a changed disk.
- VFIO/initramfs/bootloader changes can make a host unbootable. Make the change reversible and ask before rebooting.
- Subnet routing crosses a trust boundary. Scope route, ACL, and ports to the license server rather than exposing the corporate LAN.
- Confirm company policy and SolidWorks license terms permit remote checkout through this topology before operational use.

## Failures Overcome

- Assuming the Linux desktop had to migrate off NVIDIA before passthrough. The correct first check is the active renderer: hybrid systems may already render on the integrated GPU while the discrete GPU is merely bound to its native driver.
- Treating `Tailscale installed on Windows` as equivalent to `Windows can reach a LAN server behind another node`. A subnet route must be advertised, approved, accepted, and allowed by ACLs.
- Advertising an entire 192.168.x.0/24 for one license server creates unnecessary exposure and collides with common home LANs. Prefer the server's /32.
- Changing QEMU device topology while retaining a frozen migration image makes resume unsafe or impossible. Frozen state is valid only with the exact original topology.
- Using RDP because the GPU appears in Device Manager can leave CAD rendering on a software or virtual path. Verify GPU utilization inside the actual remote session.
- Optimizing a blocked network path before enumerating every connected interface produced elaborate workarounds while a faster clean network was already attached. Enumerate all paths first.
