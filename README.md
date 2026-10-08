## Related: QuizStudent

This repo (`Quiz`) is the **instructor app** — a Windows Electron app that runs the
quiz session, hands out the PIN and QR code, and controls the quiz.

[`QuizStudent`](https://github.com/Chie03-dev/QuizStudent) is the companion **student app** —
the client students open on their phones to join the session, view questions, and submit
answers. It connects to the instructor app over WebSockets on the local network.

Together they form the full quiz flow:

| Role | Repo | Runs on |
| --- | --- | --- |
| Instructor (host) | `Quiz` (this repo) | Windows PC |
| Student (client) | `QuizStudent` | Phones (browser / PWA) |

Both apps share the same wire protocol (`docs/protocol.md`). The instructor app is
authoritative: it owns timers, pause state, and scoring, and never sends answer keys to
students.

## Requirements

- Windows 10/11
- Node.js 20 or newer
- The instructor PC and the phones must be on the same LAN (same router/Wi-Fi)
- Client isolation / "AP isolation" must be **off** on the Wi-Fi, or phones cannot
  reach the PC.

## Install and run

```bash
npm install
npm run dev        # development, with hot reload
npm run build      # typecheck + production bundle into out/
npm start          # run the production build
npm run typecheck  # types only
npm run check      # end-to-end protocol checks against a real server
npm run ui-check   # clicks the real UI; needs the app started with
                   # --remote-debugging-port=9222 (see Testing the real UI)
```

The port shown in the app is the one actually bound. The server tries 8080 first
and falls back to the next free port, up to 8089. That range is defined once in
`src/shared/types.ts` (`FIRST_PORT` / `MAX_PORT`) and reused by the firewall
rules, so the two cannot drift apart.

## Joining from a phone

1. Start the app with `npm run dev`.
2. Point a phone camera at the QR code, or type the endpoint shown under it
   (for example `192.168.0.235:8080`) and then enter the PIN.
3. The student appears in the **Students** list as *connected*. If they stop
   sending heartbeats for 10 seconds the status becomes *disconnected*; it returns
   to *connected* automatically when they come back, and a phone that presents the
   same device token keeps its original student identity.

Answer keys are never sent to phones.

## Windows firewall

Windows blocks incoming connections by default, so phones cannot reach the server
until you allow it. The app checks for this when it opens.

### The "Allow phones to connect" button

If the rules are missing, an amber notice appears above the PIN and QR code:

> Phones may not be able to connect until you allow this app through the
> Windows firewall.

Click **Allow phones to connect**. Windows shows a single **User Account
Control** prompt (*Do you want to allow this app to make changes to your
device?*) the first time; after you accept it, a green **Phones can connect**
message appears and then fades. The prompt only ever comes from that button —
the app never installs anything on its own, and reading the rules needs no
administrator rights at all.

The app passes the two `netsh` commands to an elevated PowerShell via
`-EncodedCommand` (base64 of UTF-16LE). This matters: a rule name contains a
space, and passing `name="Quiz LAN Server"` on a command line makes PowerShell
re-split it, so `netsh` receives `name=Quiz LAN Server` and fails with *"essential
parameters were not entered"*. Base64 contains only letters, digits, `+`, `/`
and `=`, so there is nothing to re-split and no file is written for the elevated
process to run. Nothing on that command line comes from the UI — every character
is built from constants in `src/main/firewall.ts`.

The commands are separated by `;`, not `&&`. `powershell.exe` is Windows
PowerShell 5.1, where `&&` is not a statement separator at all — it raises
`The token '&&' is not a valid statement separator in this version` and the whole
command is abandoned without a single rule being added. With `;`, one `netsh`
failing does not skip the others.

The two rules it adds:

| Name | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `Quiz LAN Server` | TCP | 8080-8089 | the quiz server, including the ports it falls back to |
| `Quiz LAN Discovery` | UDP | 5353 | mDNS, so phones can browse for the app |

Both are **inbound allow rules applied to every network profile**
(`profile=any`). The port range is defined once in `src/shared/types.ts`
(`FIRST_PORT` / `MAX_PORT`) and used by both the server's fallback logic and the
firewall rule, so the rule always covers every port the server can pick.

Each rule is added only when it is missing, so pressing the button twice cannot
create duplicates. There is no delete step: a rule that was just found missing has
nothing to delete, and `netsh` exits non-zero when nothing matches, which would
stop the command before the add ran.

Whether it worked is decided by reading the firewall back afterwards, never by
the exit code — `netsh` exits 0 even when a rule fails to add, which is what made
an earlier failure report itself as success.

The check runs `netsh advfirewall firewall show rule` with the name quoted and
`windowsVerbatimArguments` set. Both matter: without the verbatim flag Node
escapes the inner quote as `\"`, netsh answers *"A specified value is not valid"*
even when the rule is right there, and the app reports an installed rule as
missing — which shows the notice at startup and makes a successful install look
like it failed.

If netsh replies with anything other than a `Rule Name:` line or *"No rules match
the specified criteria"*, the app says the state is **unknown** and points you at
the command to run by hand, rather than claiming the rules are missing.

The trade-off of `profile=any`: classroom Wi-Fi is frequently classified as
**Public**, and a `Private`-only rule would silently not apply there, so phones
could not join at all. The cost is that those ports are open on any network the
instructor machine is attached to while the rules exist, including a café or
hotel Wi-Fi. If you would rather keep it closed elsewhere, see below.

To remove the rules later:

```powershell
netsh advfirewall firewall delete rule name="Quiz LAN Server"
netsh advfirewall firewall delete rule name="Quiz LAN Discovery"
```

### Do it manually instead

`setup-firewall.bat` adds the same two rules and is useful if the button fails,
if UAC is blocked by policy, or if you would rather not click. Right-click it and
choose **Run as administrator**. It must stay in step with the app: same rule
names, same ports, same profile.

### Stricter option: Private networks only

If you always know the classroom network is marked **Private** in Windows, you
can narrow the rules instead of using the default:

```powershell
netsh advfirewall firewall add rule name="Quiz LAN Server" dir=in action=allow protocol=TCP localport=8080-8089 profile=private
netsh advfirewall firewall add rule name="Quiz LAN Discovery" dir=in action=allow protocol=UDP localport=5353 profile=private
```

This keeps the ports closed on Public networks, but if the network turns out to
be classified Public the phones simply cannot connect and the app's check will
report the rules as present, so it will not warn you.

### What this button does not fix

It only addresses the Windows firewall. Other reasons a phone cannot connect are
not detected, and the notice will not appear for them:

- **A VPN such as Cloudflare WARP** breaks mDNS discovery without touching the
  firewall. Turn it off, or join by typing the address under the QR code.
- **Router client isolation / AP isolation** blocks device-to-device traffic on
  some networks. The instructor can reach the internet but phones cannot reach
  the instructor.
- **The wrong network profile or the wrong adapter**, where the displayed
  address is not the one the phone can reach. Pick the right one under "Other
  addresses".

### Check that the port is actually reachable

With the app running:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

Phones browse the app over mDNS (Bonjour) as `quiz-<PIN>`, but the QR code
carries the raw address, so joining never depends on mDNS working.

## Testing without a phone

A fake student client is included:

```bash
npm run fake-student -- --pin 1234 --name Alice
npm run fake-student -- --pin 1234 --name Alice --ip 192.168.0.235
npm run fake-student -- --pin 1234 --name Alice --no-hb   # test the 10 s timeout
```

It heartbeats every 3 seconds and caches a device token per name in
`.fake-student-token.json`, so restarting it restores the same student identity.

`npm run check` starts a real server and asserts the protocol end to end: joins,
duplicate names, heartbeat timeout, identity restore, kick, PIN errors and
throttling, address selection, new sessions, and port fallback.

## Testing the real UI

`npm run check` covers the server, but not the renderer or the IPC bridge. To
drive the actual window, start the app with remote debugging enabled and run
`ui-check` in a second terminal:

```bash
npx electron --remote-debugging-port=9222 .
npm run ui-check
```

`ui-check` attaches to the renderer over the DevTools protocol, joins two fake
students, then clicks the real buttons (Kick, an alternate address, New session)
and asserts the state the UI ends up holding. It exercises the same
`contextBridge` -> `ipcRenderer` -> `ipcMain` path a human click does.

Note: it needs the debugging port, so use it for testing only, never for a
session in front of students.

## Running quiz UI (instructor view)

When a quiz is live, the instructor window shows a top bar with live controls and a
dashboard of student cards plus per-question progress.

### Top bar

The top bar has two columns:

- **Left** (`topbar-top`): `<h1>` with the quiz title, followed by a subtitle
  (`{students} in session · {paused} paused · {finished} finished`).
- **Right** (`topbar-right`, flex wrap): live controls in order —
  `countdown` (remains `urgent` when under 30 s, `paused` when the timer is paused),
  the overall answer-completion ring (`progress` + `progress-bar` + `progress-fill` +
  `progress-label`), `timer-controls` (pause/resume and ±1 min), the `lock-toggle`
  (check to freeze students' screens; shows ON/OFF state), per-paused-student
  Approve buttons (one green **Approve** per paused card), **Approve all (n)**,
  and the `EndQuizButton` (End quiz now → Yes, end it).

### Student cards

Students are grouped under the following headers, rendered only when non-empty:

- **Connected**: cards with a progress bar and a selection checkbox.
- **Paused**: cards show the reason (`focus` or `network`), a red **PAUSED** tag,
  and a green **Approve** button to resume that individual student. Paused students
  do not appear in the Connected group, so a card can never be duplicated.
- **Finished**: cards with `Finished` + local time.

### Approve flow

1. A student pauses (lock is ON and they lose focus, or they go offline).
2. The card turns red and gains a **Approve** button.
3. Instructor clicks **Approve** for that student (or **Approve all (n)** for the
   batch).
4. The student's answers are accepted and they are removed from the paused list.

### Timer controls

`+1 min` / `−1 min` adjust the remaining clock; `Pause` / `Resume` freeze the
countdown. The progress ring and the countdown stay fully in sync with server state.
