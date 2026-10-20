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
npm run dist       # package a portable Windows .exe into release/
npm run typecheck  # types only
npm run check      # end-to-end protocol checks against a real server
npm run ui-check   # clicks the real UI; needs the app started with
                   # --remote-debugging-port=9222 (see Testing the real UI)
```

The port shown in the app is the one actually bound. The server tries 8080 first
and falls back to the next free port, up to 8089. That range is defined once in
`src/shared/types.ts` (`FIRST_PORT` / `MAX_PORT`) and reused by the firewall
rules, so the two cannot drift apart.

## Download a build

Prebuilt executables are published on the
[Releases page](https://github.com/Chie03-dev/Quiz/releases). Two kinds are
published for every version:

| File | What it is |
| --- | --- |
| `QuizInstructor-<version>-setup.exe` | An installer. It puts the app in `%LOCALAPPDATA%\Programs\Quiz Instructor` and leaves a shortcut on the desktop. No admin rights, no Program Files. **Use this one.** |
| `QuizInstructor-<version>-portable.exe` | The app in a single file, unpacked to a temporary folder on every start. Nothing is installed. |

**Latest release: [v0.2.5](https://github.com/Chie03-dev/Quiz/releases/tag/v0.2.5)**.

Prefer the installer: the portable build unpacks itself into a new folder on
every run, so Windows treats it as a new program each time and may ask about
the firewall again and again. The installer keeps one stable path.

### What is new

| Version | What it brings |
| --- | --- | --- |
| **v0.2.5** | **The mark is where you clicked.** The editor for an answer sat at the end of the page, so clicking a wrong answer meant scrolling down to find it. It is now a drawer at the bottom of the screen: it opens where you are, says who and which question, and closes with Escape. |
| v0.2.4 | **The score sheet fits the screen.** The table of students x questions sat in a narrow column and always scrolled sideways. It now has the width, the questions are shown a page at a time, and the student column and the total stay put. A compact switch fits twice as many questions on a page. |
| v0.2.3 | **The importer reads a printed exam.** A Word document or PDF with unnumbered questions and choices without letters now comes in as questions with their choices - a paper with no answer key comes in as drafts, with one clear note instead of thirty warnings. PDFs are supported too, and a section name is no longer read out of a sentence ("A **connection** between two tables" is not a *Connect* section). |
| v0.2.2 | **The case, the spaces and the dashes do not count.** A written answer is compared without them, so `tokyo` is right for a key of `Tokyo` and `e mail` is right for `e-mail`. The score sheet says when an answer only matched because of that, and suggests the closest answer when a student was nearly right. An enumeration also counts the same answer only once now. |
| v0.2.1 | **Phones connect, first time.** The app now asks at startup when Windows is blocking the quiz server, and the dashboard always shows the firewall state instead of only when something is wrong. The check works on non-English Windows (it used to read every rule as "unknown" there, so the fix was never offered). The manual commands and `setup-firewall.bat` are shipped with the app. Plus an installer build with a stable path. |
| v0.2.0 | **Results and score sheet.** Every finished session is saved and scored for you: a question list with the right answer and how many students got it, and a students x questions grid. Click any cell to change the points, the mark or add a note. Grading covers all eight question types, with partial credit for multi-part ones. |
| v0.1.0 | The first portable build: quiz library, quiz editor, live session with counts only, and the meme tray. |

- The app runs from a temporary folder when you use the portable build; your
  quizzes and memes stay in `%APPDATA%\quiz-instructor`, exactly like the
  development build.
- **Windows may warn about an unknown publisher.** The build is not code-signed,
  so SmartScreen shows *"Windows protected your PC"*: click **More info** ->
  **Run anyway**. Same for a possible antivirus warning.
- The firewall setup still needs admin rights, as any firewall change does.
  The app asks for it at startup and offers the button on the dashboard.
- The portable build is unsigned, so keep the app up to date by downloading the
  newest release; there is no auto-updater.
- Your data survives an update: the library, the memes and the saved results
  live in `%APPDATA%\quiz-instructor` and are carried over untouched.

To build it yourself:

```bash
npm run dist
# -> release/QuizInstructor-<version>-portable.exe
# -> release/QuizInstructor-<version>-setup.exe
```

Pushing a `v*` tag builds it on GitHub Actions and attaches the `.exe` files to
a draft release (`.github/workflows/release.yml`).

> **Troubleshooting:** if `npm run dist` fails with
> `EBUSY: resource busy or locked ... app.asar`, something is holding the
> output folder - usually the editor's file watcher. Reload the editor window
> (or exclude `release/` from its watcher) and build again. `.vscode/settings.json`
> already excludes it.

## Joining from a phone

1. Start the app with `npm run dev`.
2. Point a phone camera at the QR code, or type the endpoint shown under it
   (for example `192.168.0.235:8080`) and then enter the PIN.
3. The student appears in the **Students** list as *connected*. If they stop
   sending heartbeats for 10 seconds the status becomes *disconnected*; it returns
   to *connected* automatically when they come back, and a phone that presents the
   same device token keeps its original student identity.

Answer keys are never sent to phones.

## Importing a quiz

**Quizzes** -> **Import…** reads a paper you already have: a Word document
(`.docx`), a PDF, a Markdown file (`.md`) or an exported quiz (`.json`).

### A printed exam

Most exam papers are printed for a student, not for a program: the questions
are not numbered, the choices carry no letters and the answer key is not in
the file at all. The importer reads that shape:

- a line that asks something - it ends with a question mark, or with a colon
  and reads like a sentence - is a **question**;
- the lines under it, up to the next question, are its **choices**, four of
  them usually;
- a choice that prints its letter (`A.`) keeps that letter, and one that does
  not is given the next free letter. A paper that mixes both reads right;
- a heading such as `MULTIPLE CHOICE` sets the question type; without one the
  questions are read as multiple choice, which is what a printed paper is.

So a Word document with thirty unnumbered questions comes in as thirty
questions with their four choices each.

### The answer keys

A key is read from, in this order:

- a **marked** choice or answer - bold, underlined or highlighted. The style is
  detected across the file, and the import dialog can pin it if the paper uses
  more than one;
- an **`Answer:` line** under the question ("Answer: B", or the text of the
  choice);
- an **Answer Key** section at the end of the document.

**A paper without a key comes in without one.** The questions arrive as
drafts, and the import says so once:

> This file holds no answer keys, so the correct answer was not determined for
> any of the 30 questions. They were imported without one - set the correct
> answer in the editor before running the quiz.

A question without a key is a draft, and a quiz with a draft cannot be
started, so nothing runs with a missing answer. Set the keys in the editor
and the questions turn ready.

### What cannot be read

- **A scan.** A PDF that is a photograph of a paper holds no text; the import
  says so instead of bringing in an empty quiz. The same goes for an image
  file.
- **A table of choices.** A printed table of choices is read as a table, not
  as choices. Write the choices on their own lines, or keep the table for a
  matching or connect question, which is what tables are for.

The import report lists every question that came out and every warning, so a
paper that did not read the way you expected says what it did with it.

## Windows firewall

Windows blocks incoming connections by default, so phones cannot reach the server
until you allow it. The app checks for this when it opens.

### The startup prompt

On a PC where the rules are missing, the app asks once at startup:

> Phones cannot connect to this PC yet.
> Windows Firewall is blocking the quiz server on ports 8080-8089, so phones on
> the same Wi-Fi cannot join.

**Allow phones to connect** raises the Windows **User Account Control** prompt
and installs the rules. **Not now** changes nothing: the dashboard still shows
the amber notice with the same button, so the setup can be done at any time.

The prompt is only there when the rules are genuinely missing. Once they are in
place it never appears again on that PC.

### The "Allow phones to connect" button

The dashboard shows the state of the firewall at all times:

| State | What you see |
| --- | --- |
| Ready | a quiet green line, *Firewall: ready, phones can connect*, with a **Check again** link |
| Blocked | the amber notice with the **Allow phones to connect** button |
| Unclear | a grey notice that still offers the button |

The button is only shown when there is something to do, and it only adds the
rules that are missing, so pressing it twice cannot create duplicates. It raises
a single **User Account Control** prompt (*Do you want to allow this app to make
changes to your device?*) the first time; after you accept it, a green **Phones
can connect** message appears and then fades. The prompt only ever comes from
that button or the startup prompt — the app never installs anything on its own,
and reading the rules needs no administrator rights at all.

### When the button cannot help

If the app cannot raise the UAC prompt (a school laptop, a policy that blocks
elevation, a user who cancelled), the same notice has a **Do it manually** link
that shows the two commands to paste into PowerShell *as administrator*:

```powershell
netsh advfirewall firewall add rule name="Quiz LAN Server" dir=in action=allow protocol=TCP localport=8080-8089 profile=any
netsh advfirewall firewall add rule name="Quiz LAN Discovery" dir=in action=allow protocol=UDP localport=5353 profile=any
```

The same two commands are in `setup-firewall.bat`, which is shipped next to the
app (right-click it, **Run as administrator**). In a packaged build it sits in
the `resources` folder next to the app.

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

The check asks Windows for the rules with the NetSecurity cmdlets
(`Get-NetFirewallRule -DisplayName ...`) and reads the objects they return, not
the text `netsh` prints. This matters: netsh's wording is translated, so on a
non-English Windows *"No rules match the specified criteria"* is a different
sentence and the old text matching read **every** rule as *unknown*. The app
then could not tell that the firewall was ready, could not tell the instructor
that it was broken, and never offered the fix — the phone simply could not
connect. The cmdlets return data, not prose, so the check reads the same in
every language.

The lookup is by **display name**, because `netsh`'s `name=` sets that field
while the internal name of a netsh-created rule is a GUID, and `-Name` on the
cmdlet actually matches the instance id — a lookup by `-Name` finds nothing at
all.

If the cmdlets are not available the app falls back to
`netsh advfirewall firewall show rule` with the name quoted and
`windowsVerbatimArguments` set. Both matter there: without the verbatim flag
Node escapes the inner quote as `\"`, netsh answers *"A specified value is not
valid"* even when the rule is right there, and the app reports an installed rule
as missing — which shows the notice at startup and makes a successful install
look like it failed.

If neither way can tell, the app says the state is **unknown** — and still
offers the button, so the instructor is never left without a way forward.

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
names, same ports, same profile. It is shipped with the app, in the `resources`
folder next to the app, and the dashboard's **Do it manually** link opens that
folder for you.

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
npx electron . --remote-debugging-port=9222 --user-data-dir=.tmp/ui-profile
npm run ui-check
```

**Give the test its own profile.** `--user-data-dir` points the app at a
folder of its own, so the check gets a fresh library with the sample quiz and
never touches your own quizzes and results. Without it the check runs against
your real profile, and it fails as soon as your library holds a quiz that
cannot be started - a draft, for instance - because the dashboard starts the
quiz it finds first.

`ui-check` attaches to the renderer over the DevTools protocol, joins two fake
students, then clicks the real controls by their stable `data-testid` (Kick, an
alternate address, New session, Start quiz, End quiz) and asserts the state the
UI ends up holding. It exercises the same `contextBridge` -> `ipcRenderer` ->
`ipcMain` path a human click does.

For a visual review, `npx tsx scripts/shots.ts` (same debugging port) writes
screenshots of each screen to `shots/`.

Note: it needs the debugging port, so use it for testing only, never for a
session in front of students.

## Instructor UI (design system + shell)

The instructor window is a desktop dashboard: one persistent app shell with a
left sidebar, and screens rendered inside it. A screen never replaces the shell.

### Layout

- **Sidebar** (`src/renderer/components/AppShell.tsx`): brand mark plus four
  nav entries - **Dashboard**, **Quizzes**, **Results**, **Live session** -
  with a badge on Live session showing the live/ended state or the
  connected-student count. A footer note reminds you it runs on your local
  network.
- **Top bar**: screen title and subtitle on the left, screen-specific actions
  on the right.
- **Content**: a scrolling area the active screen renders into.

### Screens (`src/renderer/screens/`)

- **`Dashboard.tsx`** - the landing screen. Stat cards (connected count,
  session PIN, quiz count); a "Join this session" panel with the PIN, QR code,
  endpoint and other-address buttons; a "Ready to start" panel with the quiz
  picker and Start quiz (confirmation-gated); and a Students panel with a
  roster (avatars, status badges, Kick).
- **`QuizLibrary.tsx`** - your quizzes: create, import, duplicate, export,
  delete (confirmation-gated), and open in the editor.
- **`QuizEditor.tsx`** - title, time limit, per-question cards with a status
  badge (draft/ready), live validation problems, reorder/delete, and the
  type-specific question forms.
- **`LiveSession.tsx`** - the running and ended views.
- **`Results.tsx`** - the saved sessions (list) and the score sheet of one
  session (detail).

### Results

Every finished session is saved as a **result session** and scored for you.

- **When it is saved**: when the quiz ends, by the timer or by the instructor.
  The run's answers are snapshotted together with the questions and their
  answer keys, so the sheet still reads correctly after a library question is
  edited or deleted. There is one result session per run; saving again
  replaces it.
- **The list** (`Results` in the sidebar, or the *Results* button on the
  dashboard) shows every saved session: the quiz, when it ran, why it ended,
  how many students took it and what the quiz was worth. A session can be
  deleted (its students, questions and answers go with it).
- **The score sheet** has a question list (the right answer and how many
  students got it) and a grid of students x questions. Each cell shows the
  answer, whether it was right and the points it earned; wrong answers stand
  out.
- **The sheet never scrolls sideways.** A paper with thirty questions is far
  wider than any window, so the questions are shown a page at a time - the
  buttons in the panel header say which page is on screen (`Q1-4`, `Q5-8`), and
  a page holds exactly as many questions as fit. The student column stays put
  on the left and the total stays put on the right, so you never lose your
  place.
- **The compact switch** shrinks a cell to its mark and its points, so twice as
  many questions fit on a page. The answer is still in the tooltip and in the
  editor.
- **The question list** is the narrow column on the left and scrolls on its
  own, so the score sheet keeps the width.
- **Marking by hand**: click any cell to change the points, the mark
  (correct / wrong / not graded) and a note. The student's total follows, and
  the cell is flagged as no longer auto-graded.
- **The editor is a drawer at the bottom of the screen.** It used to sit at the
  end of the page, so clicking a cell meant scrolling down to find it. Now it
  slides in over the bottom of the window, with the question and both answers
  on the left and the points, the mark and the note on the right. It says who
  and which question it is (`Cara - Q4`), Escape closes it, and the page keeps
  room under the last row of the sheet so it can still be reached.
- **Grading rules** (all overridable): mcq on the option id, true/false on the
  boolean, identification on the accepted answers, fill-in blank by blank,
  enumeration on the accepted items, matching and connect pair by pair, and
  problem questions on the answer, with the stored tolerance when there is one.
  Multi-part questions get partial credit.
- **The case, the spaces and the dashes do not count** in a written answer.
  A key of `Tokyo` accepts `tokyo`, `TOKYO` and `  Tokyo `; a key of
  `e-mail` accepts `e mail`, `e–mail` and `email`. A phone keyboard drops a
  space and a word processor swaps the dash, and the student still knows the
  answer. The score sheet says when an answer only matched because of that
  ("Right, but the case, the spacing or the dashes were different"), so the
  instructor can see it and mark it wrong if they want to.
- **The closest answer is suggested.** A student who wrote `Pariss` for a key
  of `Paris` sees the key offered next to their answer, so a slip is obvious
  at a glance. Nothing is suggested when the answer is simply a different
  word.

**The phones never see any of this.** Grading, the answer keys and the score
sheet stay in the instructor app; no new message is sent to a phone.

### Live session

While a quiz runs, the live session takes over the content area:

- **Hero bar**: the countdown clock (`urgent` under 30 s, `paused` when the
  timer is frozen), the overall answered-% progress bar, timer controls
  (Pause/Resume and +1/-1 min), the lock toggle, Approve all (n), and
  **End quiz now** (confirmation-gated).
- **Students**: grouped under Connected / Paused / Finished / Disconnected
  (rendered only when non-empty). Each card has a progress bar; paused cards
  show an **Approve resume** button.
- **Per question**: each question with an answered-count bar.

### Memes

The **meme tray** is the instructor's jumpscare: a shelf of images that can be
popped full-screen onto the students' phones mid-quiz.

- **Where it lives**: a panel at the bottom of the Dashboard column, and a
  horizontal strip above the student cards on the live screen.
- **Adding**: *Add memes* opens the OS file picker. The image is compressed in
  the renderer (max 1024 px on the long edge, JPEG unless it needs its
  transparency) and stored in the app database; the file itself lands in
  `<userData>/memes`. A fresh profile gets one sample meme; deleting every
  meme never brings it back.
- **Popping**: *Pop* sends the meme to every connected phone. The meme is also
  selected, so the per-student zap button on a student card pops it at that
  one student only.
- **Dismissing**: while a meme is up, *Dismiss meme* clears it everywhere.
- **The clock keeps running.** A meme is cosmetic: it never pauses the
  countdown, never pauses a student, and never produces `focus_lost`. The
  student keeps answering under the overlay - at the cost of quiz time. Freeze
  the countdown with the timer control if you want to talk it through.
- **The phone fetches the image itself** from `GET /memes/<file>` on the same
  server and port; only a relative path travels over the socket. An old phone
  that does not know `meme_pop` ignores it silently.

### Approve flow

1. A student pauses (lock is ON and they lose focus, or they go offline).
2. Their card moves to the **Paused** group and gains an **Approve resume** button.
3. The instructor clicks **Approve resume** for that student (or **Approve all (n)**
   for the batch).
4. The student's answers are accepted and they return to the connected group.

### Design system

Tokens and shared primitives keep the UI consistent:

- `src/renderer/tokens.css` - one source of truth for colour, spacing, radius,
  elevation and type. Components never use raw hex or ad-hoc pixel values.
- `src/renderer/ui.css` - shared primitives: `ui-btn`, `ui-panel`, `ui-badge`,
  `ui-field`, `ui-empty`, and the visible focus ring.
- `src/renderer/components/` - shared React components: `Button`/`IconButton`,
  `Icon` (inline SVG, no icon pack), `Panel`, `Badge`, `EmptyState`,
  `ConfirmButton`, `Field`, `LockToggle`, `AppShell`.
- `src/renderer/memes/` - the meme tray (`MemeTray.tsx`), the instructor's
  own preview (`MemeOverlay.tsx`) and the renderer-side image compression
  (`compress.ts`).

The UI never shows scores - counts and progress only. The server owns the clock
and the timers; the UI just renders `endsAt` / `remainingMs` / `timerPaused`.
