# Playground+

Playground+ is a local application built on the Bo playground. AI agents write Bo puzzles for the person
using it, the person plays them in the playground, and Bo records what happens so that the next puzzle can
fit. A local model can also be watched playing a puzzle the person has already played, and a finished run can
be replayed. Everything runs on the user's own computer; nothing leaves it.

Status: implemented and experimental. Bo stays experimental and local; nothing here is a compatibility
commitment.

Terms: **PG** (or the playground) is the static page in `playground/`, published to GitHub Pages;
**Playground+** is the local application in `playground-plus/` that serves it with more around it; the
**runtime** is the WebAssembly build of Bo in `wasm/`.

## What it does

- **Puzzles written for you.** The "New puzzle" button asks for a puzzle (optionally a topic, and a bit
  easier or harder than the last). It is written by a local model through [Ollama](https://ollama.com), or by
  the AI assistant of your choice, which connects through an MCP server. The model sends a short *spec*;
  Playground+ builds the puzzle, runs your solution on the real Bo machine to find the expected results,
  checks it, and refuses what is wrong or not new.
- **You play in the playground.** A puzzle is an ordinary playground puzzle. The prompt is the way to
  answer; `guess` checks, `hint` helps, `reveal` gives up. What you do is recorded (the lines you type, not the
  editor), and the next puzzle is chosen from how you are doing.
- **My profile.** Statistics about your play and the agents' play, and a plain account of what is stored
  about you, which can be shown, exported and erased.
- **Watch an agent play.** A local model tries a puzzle you have already played while you watch, in the
  playground itself or as text with its thoughts. The run is recorded, and any recorded run can be replayed
  at the pace it had.

## Principles

- **The LLM authors; Bo verifies.** Every puzzle runs through checks on the real Bo machine before a human
  sees it. There is no second implementation of the language (no abstract solver).
- **Goals are open.** A goal is whatever Bo validator the puzzle ships, as in `examples/puzzles/`. Nothing
  restricts it to a catalogue of goal kinds.
- **Narrow tools, no raw access.** Agents get workflow tools, never SQL or the filesystem.
- **Record raw structured events**, never only LLM summaries.
- **Adaptive play, not controlled experiments.** Puzzle and session features are recorded so that analysis
  is possible later; nothing is designed as an experiment.
- **LLM-supplied Bo runs only in WebAssembly** (browser or Node), never in the native C or Python runtimes.
- **The playground does not know about Playground+.** Playground+ imports the PG, never the reverse.

## Running it

The full build needs `cc`, `python3`, Git, Node 22.13 or later, npm and uv.
From a clone of the repository:

```
make all             # installs missing dependencies and builds all components
make playground-plus # serves http://127.0.0.1:8777/ and opens it in a browser
```

The first build can involve large downloads, including Emscripten into `~/emsdk`
if it is not already available. `make all` checks for existing dependencies on
subsequent runs.

`PORT=9000` picks another port and `OPEN=0` does not open a browser (also `PLAYGROUND_PLUS_PORT` and
`PLAYGROUND_PLUS_OPEN=0`). The command prints the MCP configuration for this checkout. The plain playground is
`make playground`. The data is in `playground-plus/data/` (git-ignored): the database
(`playground-plus.sqlite`, or `$PLAYGROUND_PLUS_DB`) and the transcripts of the local models.

For puzzles written here, install Ollama and pull a model that can use tools, for example
`ollama pull gemma4:12b` (also measured: `qwen3.5:9b`). The page says whether a local model is available: under
the wordmark, "Bo runtime 0.8.0 | Agent connected (Ollama)" or "... | Agent not connected (manual prompt
required)", with the reason and what to install in its tooltip. Models under 7B parameters, which fail at the
task, are not offered. Without Ollama everything else works, and puzzles can be asked from your own assistant.

To connect an assistant, add the MCP server (see "MCP server"). To check puzzle files from the command line:
`node playground-plus/validate.mjs FILE...`.

## Layout

```
 your assistant --MCP (stdio)--> mcp.mjs ----+
                                             |--> service.mjs --> harness.mjs (Bo in WebAssembly)
 the page <--HTTP, server-sent events--> server.mjs / api.mjs --+--> db.mjs --> SQLite
   (playground + client/)                    |
                                  generator.mjs, agent-player.mjs --> Ollama
```

A static page cannot be an MCP server, so a local companion process is needed. It serves the playground
files, exposes the API, runs the harness, and owns the database. Tool and API logic live in plain modules
(`service.mjs`); MCP and HTTP are thin adapters over them.

- `playground/` is the PG and `wasm/` the runtime, both unchanged by Playground+ except for the optional
  extension points below. The PG keeps zero npm dependencies; Playground+ has its own `package.json`.
- **Shared pieces, not copies.** The runtime and its wrapper `wasm/bo.mjs` are used by the PG in the browser
  and by the harness and the agent player in Node. `examples/puzzles/lib.bo` (the puzzle protocol) is shared.
- **Extension points in the PG** (`playground/config.mjs`, all optional, doing nothing by default): `onEvent`
  (the store reports each action: code, result, machine state before and after), `puzzleProvider`
  (`load()` and, optionally, `subscribe()` for puzzles that arrive while the page is open) and
  `beforeAction(name)` (asked before the editor opens, the editor's program is shared, everything is emptied,
  or something is chosen in the picker). Playground+ sets them and then imports `app.mjs`, by serving
  `playground/index.html` with its boot script (`client/boot.mjs`) in place of the `app.mjs` tag, so the page
  is not copied. The page shows a "+" next to "Playground". Everything else (the buttons, dialogs, the
  banner for a watched agent) is added by Playground+'s own scripts, with their own styles.
- **The server** (`server.mjs`) listens on `127.0.0.1` only, refuses a Host that is not a loopback name (DNS
  rebinding), serves only `playground/`, `wasm/`, `examples/`, `images/` and `playground-plus/client/` (without
  `vendor-src` or tests), and its POSTs need `application/json` and a same-origin request. A page that is
  open learns of new puzzles through server-sent events (`GET /api/stream`, a database watcher in `stream.mjs`,
  which also works for puzzles stored by the MCP server, another process).
- **A hosted PG does not talk to Playground+.** Browsers can call `localhost` from an `https` page, but
  support is uneven. Playground+ serves its own pages from its own origin.
- **Distribution is a clone and `make all`.** The full build installs missing dependencies and builds the
  WebAssembly runtime before Playground+ is launched.
  The Pages workflow publishes `playground/`, `wasm/` and `examples/` only, so it cannot be affected.
- **Build and tests.** `make test-wasm` and `make test-playground` test the runtime and the PG;
  `make test-playground-plus` tests Playground+ (its tests need no Ollama; the WebAssembly build is optional
  for most).

| Module | Role |
|---|---|
| `main.mjs`, `open.mjs` | The command: port, database, opening the browser, the MCP configuration. |
| `server.mjs`, `api.mjs`, `stream.mjs` | Static files, the JSON API, server-sent events. |
| `db.mjs` | SQLite behind a repository: puzzles, sessions, events, requests; versioned migrations. |
| `service.mjs` | Everything that is done with puzzles and records, without a transport. |
| `compile.mjs`, `harness.mjs`, `tokens.mjs`, `validate.mjs` | Spec to puzzle file, checks on the real machine, counting what a player typed, the command. |
| `brief.mjs`, `taxonomy.mjs` | What to write next; the vocabulary shared with the page. |
| `mcp.mjs`, `guide.md` | The MCP server and the guide it serves. |
| `generator.mjs`, `agent-player.mjs`, `agent/` | The local puzzle writer, the local agent that plays, and their shared loop and Ollama client. |
| `client/` | The page's scripts: `boot.mjs`, `recorder.mjs`, `provider.mjs`, `new-puzzle.mjs`, `profile.mjs`, `watch.mjs`, `stage.mjs`, `page-control.mjs`, `dialog.mjs`, `api.mjs`. |
| `eval/run.mjs` | The measurement of how well a model writes puzzles (`make llm-eval`). |

### API

JSON under `/api/`. Every body is size-limited and validated; every POST needs a JSON object and a same-origin
request (a request carrying another Origin is refused).

| Endpoint | |
|---|---|
| `GET /api/puzzles` | The stored puzzles (with `played`: the person has a session on it). |
| `POST /api/sessions`, `/api/sessions/:id/events`, `/api/sessions/:id/end` | Recording (see "Recording"). |
| `GET /api/generator`, `POST /api/generate`, `GET /api/generate/status`, `POST /api/generate/cancel` | The local puzzle writer. |
| `POST /api/requests`, `GET /api/requests/pending`, `POST /api/requests/:id/cancel` | A request for a puzzle, for the person's own assistant. |
| `GET /api/profile`, `GET /api/profile/export`, `POST /api/profile/erase` | The profile and the person's data. |
| `GET /api/agent-play`, `POST /api/agent-play`, `GET /api/agent-play/status?since=n`, `POST /api/agent-play/cancel` | Watching an agent play. |
| `GET /api/agent-play/runs`, `GET /api/agent-play/runs/:id` | Recorded runs that can be replayed. |
| `GET /api/stream` | Server-sent events: a puzzle was stored. |

## Puzzle package

A package is **one Bo file**, the same format as the playground's own puzzles (`examples/puzzles/`): a
`;@puzzle` comment header, then the setup source using the puzzle protocol (`puzzle.require`, `guess`,
`puzzle.hints`, `puzzle.reveal`). A second layer (JSON) was rejected as the *stored* format: it would need a
renderer that could drift from the file the player actually runs, and the existing puzzles become test
fixtures for the harness. (What agents *send* is a small JSON spec that is compiled into this file: see
"Puzzle specs".) The file is validated in two layers: a strict header parser (`parsePuzzle` in
`playground/puzzles.mjs`, with size limits) and the harness running it on the real machine.

Header directives (the first five are the playground's; the rest are used by the harness):

- `;@title`, `;@goal`, `;@description` (multi-line), `;@hints N`, `;@hide NAME`.
- `;@freehints N` (0 to 2, at most `;@hints`): the first N hints are free. They are the first N texts of
  `puzzle.hints`, and the setup pushes the number N onto `puzzle.free`. A free hint is not recorded on
  `puzzle.hint-used` (only `puzzle.hint-shown`), so using it neither counts in the statistics nor turns a
  solve into "solved after using a hint". The goal panel says "(the first is free)".
- `;@tags a b c`: concept tags (lowercase letters, digits, hyphens; at most 8).
- `;@difficulty 1-5`: the author's claim (for a spec, an estimate made from the solution).
- `;@solution LINE`: a reference prompt line (at least one for a submitted puzzle; the first is canonical
  and its token count gives the best-known length).
- `;@right LINE` and `;@wrong LINE`: sample prompt lines that must, or must not, solve the puzzle. Each runs
  on a fresh setup.

The **ID** is the hash of the file text with line endings and trailing whitespace normalised, so a puzzle is
immutable and a small edit is a new puzzle. **Provenance** (client, model, time) lives in the database, never
in the file, so it does not change the ID. Every description ends with "Run `guess` to check your solution."

Tags come from a closed list (`TAGS` in `taxonomy.mjs`): `shuffle`, `arithmetic`, `conditional`, `quotation`,
`list`, `recursion`, `definition`. The first tag of a puzzle is in its title.

## Puzzle specs (what an agent sends)

Experiments showed that small local models can write the creative part of a puzzle but not the mechanics:
header counts, quoting, the check, and above all the *expected values* (arithmetic slips in the check were the
commonest reason for failure). So agents do not write the Bo file. They send a **spec**, and `compile.mjs`
builds the file, finding the expected results by running the agent's solution on the real machine. Agents
write only the goal, the hints, the tags and the data. The raw file path still exists as an escape hatch
(`validate_bo_puzzle` / `submit_bo_puzzle`, offered only with `PLAYGROUND_PLUS_RAW=1`, and the service
functions `validatePuzzle` / `submitPuzzle`).

| field | |
|---|---|
| `kind` | `arrange` or `define` (see below) |
| `tags` | 1 to 3 from the closed list; the first is the main one |
| `goal` | what to do, 10 to 300 characters, `backticks` for code |
| `inputs` | a list of stacks (bottom first) of whole numbers or lists of whole numbers (\|n\| up to 1,000,000) |
| `solution` | the Bo ops that solve it; the expected values are what it produces |
| `op` | `define` only: the name of the op the player defines |
| `hints` | 1 to 3 texts, gentlest first |

Written by the compiler: the title (`<Main tag> #<n> · <agent>`, where the agent is the model name or the
client's name and `n` the puzzle's number in the player's list), the difficulty (an estimate from the number
of tokens in the solution, one more for a conditional or iteration op), `;@hints`, the check, the reveal
text, the sample wrong answers, and the description (the start and target stacks, or two example calls).

- **`arrange`**: `inputs` has exactly one stack, pushed at the start. The solution is run on it and what it
  leaves is the target, checked with `puzzle.eq`. The solution must change the stack and leave something.
- **`define`**: 3 to 8 inputs. The validator, for each input, clears the stack, pushes the input, calls the
  op and compares the whole stack with what the solution left, with `puzzle.eq`; a case that differs
  leaves a record on `puzzle.mismatch`. One free hint is added saying how to define an op. The compiler
  refuses inputs that do not tell a wrong op from the right one: all different, not all unchanged (an empty
  definition would pass) and not all giving the same result (an op ignoring its input would pass); the file
  also carries those two as `;@wrong` samples, which the harness checks again. An op name that already
  exists in Bo is refused.
- **Placeholders**, registered in `KINDS` but not offered in the tool's schema: `predict` (say what a program
  leaves), `fix` (repair a definition), `golf` (shortest definition), `named-stack`.

Problems with a spec are reported in its own terms (`PROBLEM inputs[0] must be ...`), all at once. After a
good validation the report shows what the solution produced, so an agent notices when it is not what it
meant. A spec can warn (a hint containing the solution, a goal that does not mention the op, a tag the
solution does not obviously use). Novelty works on specs too: the same goal, or the same kind, inputs,
solution and op name as a guide example or stored puzzle, is refused. A retry of an identical spec is
recognised, because the spec is kept in the puzzle's package.

Values are whole numbers and lists of them only, so that expected results are exact (no floating point) and
print as literals. Strings and deeper lists could be added later.

## Harness checks

Implemented in `harness.mjs` (`validatePuzzle`), with the command
`node playground-plus/validate.mjs [--json] [--budget OPS] FILE...` (exit status 1 if invalid). It runs on
the real machine in WebAssembly (an in-memory file system, so the puzzle's code cannot reach the host), and
every run is stepped under an op budget (`bo.debug.run(limit)`, 200,000 by default), which also stops loops
inside validators (`call`, `map`). A check is an `error` (fails the puzzle) or a `warning` (advice). The
result is `{ok, id, puzzle, checks[], metrics}`.

1. **header** (error): the header parses, the limits hold (file 64 KiB, title 120, goal 300, description
   4,000 characters), and a submission has `;@solution`, `;@tags` and `;@difficulty`. Every
   solution/right/wrong line must be valid Bo (balanced). All problems are listed together, and nothing else
   runs until they are fixed. **samples** (warning): no `;@wrong`.
2. **setup** (error): it runs to the end within the budget. **protocol** (error): it called `puzzle.require`.
3. **hints** (error): `;@hints N` equals the number of texts the setup pushes onto `puzzle.hints`; the
   message says what to change. **freehints** (error, when there are any): `;@freehints N` equals the number
   pushed onto `puzzle.free`. **reveal** (warning): there is a `puzzle.reveal` text.
4. **untouched** (error): `guess` on the untouched puzzle is not solved, and does not raise an error.
5. **solution:N**, **right:N** (error): each line, run on a fresh copy of the puzzle, ends with `guess`
   reporting solved. **wrong:N** (error): the line must not be accepted, and must not hang; a wrong sample
   that raises an error is fine (it is still wrong). When a check fails the message tells why: if the check
   compares with `puzzle.eq` (an `=` that remembers the first pair that differed, on the hidden stack
   `puzzle.mismatch`) it names that pair ("compared X, what the answer produced, with Y, what the check
   expected"); if it is about the default stack, it shows that stack.
6. **typable** (warning): `clear` followed by the first solution's final stack, typed as literals, also
   solves it, so nothing enforces how the answer is reached. It flags the playground's puzzles 07 and 08 and
   not 09 (a submitted program checked by the puzzle).
7. **novelty** (error, in the service, on `submit` and `validate`): a puzzle is refused if its title or goal
   equals one of a built-in puzzle, a guide example or a stored puzzle, or if it has the same *essence* (its
   solution lines plus its setup tokens, strings left out). Found by experiment: a model asked for "a new
   puzzle" will otherwise hand back a guide example reworded, which is valid but not new.

`metrics.bestKnownLength` is the fewest top-level tokens among the solution and right lines, not counting a
final `guess` (`tokens.mjs`: an op, number, string or whole list counts once). It is a best-known length, not
an optimum. The report is structured and carries the machine's own error messages, so a failing agent can fix
and resubmit.

## Asking for a puzzle

The page has a **New puzzle** button (added by `client/boot.mjs`; the PG is untouched). It opens a dialog
(`client/new-puzzle.mjs`, on the generic `client/dialog.mjs`) with these choices:

- **How it is made.** "Write it here with a local model" is the default when Ollama is installed and has a
  model that can use tools; otherwise it is disabled and says what is missing ("Ollama was not found...
  ollama pull gemma4:12b") and "Ask my chat assistant" (copy and paste) is the default. When several models
  are installed a selector offers them, the measured ones first (`gemma4:12b`, `qwen3.5:9b`), then the rest.
- **Topic**, optional, up to 3 of the tags.
- **How hard**: a bit easier than last time, let Playground+ decide (the default), a bit harder than last
  time. "Last time" is the difficulty of the puzzle the player played last, plus or minus one; "decide" is the
  skill-based step of `get_brief`. Before the first puzzle there is nothing to compare with, so those two are
  disabled.

### Writing it here (local model)

`generator.mjs` runs an agent loop (`agent/agent.mjs`, a client of Ollama in `agent/ollama.mjs`) in the
background on the server. The model talks to a real MCP server over an in-memory connection, so it goes
through exactly what an outside agent does: the guide, `get_brief` (which reads the player's request),
validation, the novelty check, `submit_puzzle`. The puzzle's author is the model's name.

- One puzzle at a time. A try that gets stuck (more than 4 minutes, or one turn of more than 2) is given up on
  and the next one starts quietly, with no question to the player; each retry is one level easier (`get_brief`
  is given `easier`), up to three tries. An empty reply is answered with a nudge ("Please continue: call one
  of the tools") up to twice. If all tries fail the request is withdrawn and the page says why, offering "Try
  again" or "Ask my chat assistant instead". Every try is saved as JSON in `playground-plus/data/generator/`
  (the newest 30), to see why one was slow.
- The progress dialog's buttons say what they do: "Stop writing this puzzle" throws the work away (a short
  message confirms it) and "Hide this window, keep writing" only closes the window. The page polls the status
  every 1.5 seconds ("gemma4:12b is checking its puzzle · 0:42"), the time runs every second, the button
  reads "Writing a puzzle" while it works, and the state is picked up again after a reload. A click on New
  puzzle asks the server what is going on instead of trusting the page, so a stopped job cannot reappear.
- **When the puzzle arrives.** If the player was watching (the progress or waiting dialog was open, or had
  just closed because the job ended) the puzzle is loaded for them at once, through the playground's own
  picker, so the recorder sees an ordinary puzzle start. If they had hidden the dialog they are probably doing
  something else, and loading would replace it: the button turns into a filled "Your puzzle is ready: play
  it" that stays until clicked (or until they choose the puzzle in the picker), and the picker's border pulses
  for a few seconds. A puzzle from an outside agent never loads by itself and gets the same button. The
  playground's own "New puzzle: ..." toast is not relied on, since people do not read toasts.
- The picker groups: **New puzzles** (never played), **Past puzzles**, **Practice puzzles** (the playground's
  own) and **Examples**.
- Measured on a 10 GB RTX 3080: about a minute with `gemma4:12b` once loaded, plus a minute or two the first
  time while Ollama loads the model.

### Asking my own assistant (copy and paste)

Continuing records a **request** on the server (table `requests`; only one waits at a time and it expires after
30 minutes) and shows the message to paste into the assistant's chat, with a Copy button. The message names
the tools in order (`get_bo_guide`, `get_brief`, `validate_puzzle`, `submit_puzzle`) and says what the player
asked for in words. `get_brief` reads the waiting request, so the wishes reach the agent even if it ignores
the sentence. While a request waits the button reads "Waiting for a puzzle" (a request survives a reload) and
re-opens the message, with "Cancel the request". When the agent submits the puzzle, the server marks the
request fulfilled, the page announces the puzzle as usual, the dialog closes by itself and the button goes
back to "New puzzle".

MCP is agent-pulled: the UI cannot trigger an agent. Other ways to deliver a request were considered and are
not built: a standing agent that waits for requests with a long-polling tool; a stock of puzzles written ahead
in a batch (instant, but not tuned to the latest play); and MCP sampling (client support is uneven).

## The editor and the menu during a puzzle

In the PG the editor is preloaded with the puzzle's source, and running a program from it starts a fresh
machine (which wipes the puzzle in progress). So in Playground+ **the editor is not part of a recorded
challenge, and showing the source counts as revealing the solution.** While a recorded puzzle is being played,
the `+` menu under the prompt behaves like this:

| Item | During a challenge |
|---|---|
| Show editor (and the editor tab) | asks first; if the player goes ahead the session ends as `revealed` (with a `reveal` event) |
| Share the editor's program | the editor holds the puzzle's source, so it asks first and counts as `revealed` |
| Reset everything | asks first; the puzzle ends as `abandoned` |
| Choosing anything in the picker (an example, another puzzle, "Write your own") | asks "Leave this puzzle?" (`beforeAction("load")`); declining puts the picker back; going ahead ends it as `abandoned` (or `skipped` when another recorded puzzle starts) |
| Upload a file, Fast run | hidden and disabled (they only matter when practising with the editor) |

The confirmation is `confirmDialog` in `client/dialog.mjs`, a general modal dialog (native `<dialog>`; a
title, a text or DOM body, any buttons) that also serves the other dialogs. Once the challenge is over
(solved, revealed, abandoned), the menu is normal again. Practice puzzles, past puzzles and the hosted PG are
unchanged: the editor is for practice there. The page script that decides what to ask is `client/boot.mjs`.

## MCP server

`mcp.mjs` is an MCP server over stdio, built on the official SDK (`@modelcontextprotocol/sdk`, installed by
`make deps` into `playground-plus/node_modules`). It shares the database file with the web server, so a puzzle
an agent submits appears in the page, which is told by a server-sent event and shows a "New puzzle" toast. The
tool logic is in `service.mjs` (no transport, no SQL exposed), so other transports can be added without
changing it.

Tools (all narrow; there is no SQL, file or shell access):

- `get_bo_guide`: read first, about 6 KB. The fields of a puzzle spec, the two kinds, three complete examples
  (compiled and validated by the tests), what makes a good puzzle, and a Bo primer verified by the tests. Also
  the resource `bo://guide`.
- `get_bo_reference(topic?, query?)`: the `language`, `library`, `primitives` or `examples` documents (also
  whole, as resources `bo://reference/...`), so an agent never needs to read this repository. A short
  document is returned whole; a long one gives an outline, or the matching passages for a `query` (a query
  without a topic searches all of them); each answer is capped at 8,000 characters. Models tend to spiral
  into lookups instead of writing, so after 3 lookups without a validate the tool nudges the agent to draft,
  and after 4 it refuses until the agent validates (which resets the count).
- `get_brief`: what to write next, made by `brief.mjs` from the profile and the existing puzzles: the kind,
  the main topic, the difficulty and one starting idea, plus the newest goals to avoid. The difficulty is one
  step above the highest level the player solves at 60% or better (one more at 80%); the topic is one never
  tried, else the one with the lowest solve rate; the idea comes from a small curated pool per topic
  (`IDEAS`), nearest in difficulty and not used before. Small models copy examples and have few ideas of
  their own, so the server supplies the idea and the targeting. The player's own wishes (topics, easier or
  harder than the last puzzle) come from the "New puzzle" dialog as `preferences`. The brief is kept with the
  puzzle that follows it (`package.brief`), which is how "idea already used" is known.
- `get_user_profile`: totals, results by difficulty and by tag (solve rate, median seconds, hints, guesses),
  recent puzzles (the person's first plays). `get_session_history(limit)`: the newest sessions.
- `list_puzzles`: existing puzzles (title, goal, tags, difficulty, plays; never answers).
- `validate_puzzle(kind, tags, goal, inputs, solution, op?, hints)`: builds the puzzle from the spec and
  reports (problems, what the solution produced, the harness checks); nothing is stored. `submit_puzzle(...)`:
  the same fields; validates and, if valid, stores it (the same spec is stored once, and the client's name is
  kept as provenance and in the title). The tool schema carries the enums (kinds that are offered, tags).
  `validate_bo_puzzle(source)` and `submit_bo_puzzle(source)` take a whole Bo file and exist only with
  `PLAYGROUND_PLUS_RAW=1`.

Intended workflow: guide, brief, describe, validate until valid, submit.

Connecting a client (the path is the repository checkout; the server needs `make wasm` once):

```json
{
  "mcpServers": {
    "playground-plus": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/path/to/bo-lang/playground-plus/mcp.mjs"]
    }
  }
}
```

This is the form of `claude_desktop_config.json`; in VS Code use `.vscode/mcp.json` with the same command and
arguments under `"servers"` (and `"type": "stdio"`). Set `PLAYGROUND_PLUS_DB` in `env` to use another database
file (it must be the one `make playground-plus` uses to share data). `make playground-plus` prints this
configuration for the checkout.

There are no MCP tools for an agent to play a puzzle: agents play through the built-in agent player (see
"Watch an agent play"), which is not offered over MCP.

## Recording

Recording applies to the puzzles stored in Playground+'s database; the PG's built-in puzzles stay practice and
are not recorded. Tables: `puzzles`, `sessions`, `events` and `requests`. The statistics are computed from the
sessions and events, not stored.

**Only the first play counts.** Once the player has a session on a puzzle it is a *past* puzzle: the picker
lists it under "Past puzzles", the page treats it like a practice puzzle (the editor is free, nothing is
recorded, the description says so), and `getUserProfile` and `get_brief` use only each puzzle's first session.
The server still stores whatever it is sent, and `GET /api/puzzles` says `played`. Playing a puzzle twice
therefore cannot inflate or skew the statistics, and a first attempt that was abandoned stays abandoned.

- A session has a role (`human` or `agent`), the client name, the Bo version, and an outcome.
- Events carry a sequence number (assigned by the server), timestamp, duration, type, prompt line, result, the
  visible stacks before and after, and the **play state**. The PG store emits them through `onEvent` (types
  `setup`, `restart`, `evaluate`, `step`, `run`, `runFast`, `reset`, `clearStacks`, `abort`). The PG does no
  analysis; the recorder (`client/recorder.mjs`) selects what to keep (`setup`, `evaluate`, `reset`, and the
  `reveal` it adds). The timestamps are the timing: the gap between two lines is how long the person (or the
  model) took.
- **Play state** is read from hidden stacks that the puzzle runtime (`examples/puzzles/lib.bo`) keeps:
  `puzzle.last` (every guess's result: 0 missing, 1 wrong, 2 solved, 3 error), `puzzle.hint-used` (one item
  per hint that was not free) and `puzzle.revealed`. Attempts, hints, reveal and the solve are therefore
  structured data, not parsed from output text.
- **What is not recorded:** anything done in the editor (its contents, runs, steps, output). Those events are
  not stored at all, and since opening the editor during a recorded puzzle ends the session as revealed, there
  is normally nothing to record. The puzzle's own stacks (solution, messages, library ops) are not recorded
  either. The API refuses anything beyond documented fields and sizes.
- **Counting unit:** typed top-level tokens, literals included (not machine steps), counted by `tokens.mjs`
  from the stored prompt lines.
- Outcomes: `solved`, `revealed` (the player saw the source by opening the editor or sharing it, or used
  `reveal` before the solving guess), `skipped` (another puzzle was started), and `abandoned` (the player
  emptied everything, or the server inferred it after 30 minutes without activity, when it starts and when a
  session is created). A person's abandoned sessions are not counted in the solve rate.
- **What ends a challenge.** One rule covers every action that replaces the machine: after any event, if the
  puzzle's runtime (`puzzle.validator`) is gone from the machine, the session ends as `abandoned`. That
  includes `exit` (the page then starts fresh), "Reset everything", a restart of a stuck machine, and, if they
  happen to occur, an editor run, step, restart, or emptying the program's stacks (those events themselves are
  not stored). Actions that leave the puzzle in place change nothing: the Bo op `clear`, a stack's "empty"
  icon, `abort` in the debugger, errors, and wrong guesses.
- Hints are counted in the play state, with timestamps from the events. `revealed` counts as a failure.

There is no skill model: the profile is plain statistics, and the agent reads the numbers and adapts. Whether
people play matters more than how they play.

## My profile

The **My profile** button (next to "New puzzle") opens a dialog built from `GET /api/profile`
(`service.getStatistics()`):

- **You** (first plays only): puzzles played, solved, revealed and abandoned, the solve rate among finished
  puzzles, mean difficulty, median time to solve, hints per solved puzzle, tokens typed to solve and the ratio
  to the shortest answer known for that puzzle, plus breakdowns by difficulty and by topic. Tokens are
  counted at the top level, numbers included (`guess`, `hint` and `reveal` excluded).
- **Agents**: one row per model (the session's `client`), every attempt counted, with the same measures.
  They come from "Watch an agent play". For an agent, running out of time or turns counts as a failure in the
  solve rate; for a person, walking away from a puzzle does not.
- **What is stored about me**: the counts (sessions, prompt lines, puzzles, since when), *Show my data* (the
  stored human history as JSON; nothing else is kept: no name, no editor contents), *Export* (the same as a
  download) and *Erase my history*, which asks first. Erasing deletes the human sessions and events only;
  puzzles and agent sessions stay, and played puzzles become new again.

## Watch an agent play

The **Watch an agent play** button (next to "My profile") lets a local model (through Ollama, the same models
and the same 7B minimum as the generator) try a puzzle on the server while the page shows it playing. It is
the agent half of the profile: how a model does on the puzzles the player has played.

- **Only played puzzles.** The list holds the puzzles the player has played, never a new one, so watching
  cannot spoil a puzzle. The server enforces it (`403` otherwise), so another client cannot get round it.
- **What the model gets** is what a person gets: the title, goal and description, the stacks the puzzle
  starts with, a Bo prompt and the documentation, plus the "Bo in one minute" primer of the authoring guide.
  Tools: `run_bo` (one line, like the prompt), `guess`, `hint`, `look_up` (at most 4 searches of the
  documentation) and `give_up`. It never gets the puzzle's source, solution or hidden stacks: a line that
  mentions `puzzle.` or `reveal` is refused and not run (`give_up` is how a model asks for the answer), and
  the machine's error report stack is not shown to it. It plays on a WebAssembly machine on the server.
- **Limits:** 20 turns and 5 minutes, and one turn may take up to 2 minutes. A line that runs more than the
  step budget is stopped. A run that ends by itself is recorded, whatever the result.
- **Outcomes** (the session's role is `agent`, its client the model): `solved`; `revealed` (it gave up);
  `abandoned` (out of turns or time, stuck on one move, it stopped calling tools after being nudged three
  times, or it left the puzzle with `exit`). Hints are counted as for a person (the first of a `define` puzzle
  is free).
- **Recorded like a person's play.** The session is written in one go when the run ends, with the same records
  the page's recorder makes (`toRecord`): a setup event, one `evaluate` per line with the stacks before and
  after, and the play state. Unlike a person's, it also holds what the model said (`say` events), what it
  thought before acting (`think`: a model that thinks, like gemma4, often says nothing else when it calls a
  tool; kept up to 4000 characters) and what it looked up (`lookup`). Each event a model turn led to has a
  `meta` (a JSON column of `events`, added by migration 3): `{turn, modelMs, promptTokens, outputTokens,
  thinkingChars}`, kept once per turn, on the first event it led to. Every event has its `time`, so the gaps
  between lines, which for an agent are mostly the model deciding, are in the data: the events' times are the
  timing, `meta.modelMs` the model's share of it. A run the player stops, or one where Ollama failed, leaves
  nothing behind: it is not the model's result. Transcripts (what the model was told and answered) are kept in
  `playground-plus/data/agent-play/` (the newest 30) to see why a run went wrong.
- **One model at a time**: starting an agent while a puzzle is being written, or the reverse, is refused
  (`409`) so that two models do not fight over the graphics card.
- **Two ways to watch a new run**, chosen in the dialog and switchable while it plays.
  - *In the page*: the agent is shown in the playground itself, its lines typed into the prompt and run by the
    page's own machine, so the stacks move as when a person plays (the same lines give the same stacks as on
    the server; a line that never finished there is announced but not run here). The puzzle is chosen in the
    picker like the person would (so it is a past puzzle: practice, not recorded), and everything around the
    banner is `inert` (no clicks, typing or focus), so nothing the person does can get in between. The
    banner, above the puzzle card, has no frame or background of its own (its buttons and menu look like the
    usual ones) and holds *Stop the agent*, *Switch to text* and the agent's status, one line with only the
    time in bold. Nothing else is written there (the model's words, lookups and outputs are in the text
    view), so that the space above the puzzle does not change size as the run goes. When the run ends it says
    how it went, with *Replay*, *Show as text* and *Close*. The page stays taken over until *Close* is
    pressed, which is easy to miss, so the button pulses when the run ends and again at every click on the
    page. Lines appear when they happen: a live run is not paced.
  - *As text*: a dialog with the full transcript: what the model says and thinks (a thought is a fold-out
    line, open when short), what it looks up, and its lines with their outputs and stacks. It can be hidden,
    and leaves the page to the person. From the text, *Watch in the page* asks first and catches the page up
    with the steps so far at once, then follows live (a finished run is replayed instead). *Switch to text*
    belongs to a live run: a replay has *Show as text* instead, a transcript that grows with the replay, step
    by step, at the replay's own pace.
- **What the person loses.** Watching in the page replaces what is on the prompt and stacks, which the choice
  dialog says. If a recorded puzzle is in progress, the picker's usual "Leave this puzzle?" confirmation is
  asked first (the puzzle then counts as abandoned); declining cancels the agent before it has done anything.
- **Replay.** The dialog also offers an earlier run, played again in the page from its record with no model
  (so it works without Ollama). Each step waits the real gap since the one before, so the pace is the agent's.
  A model can think for minutes, so the banner has a speed: *Real time* (the default), *Compressed* (no wait
  longer than 4 s) and *Fast* (a tenth of the gap, at most 0.6 s), changeable while it plays. The time shown,
  in the banner and in the text dialog, is the original time of the step being played: at real time it ticks
  on from the last step, at the other speeds a running timer would mean nothing, so it stays at when the agent
  did that step, and the dialog keeps the length of the run when it ends. Runs recorded before `say` and
  `think` events existed show the lines only. Only runs on puzzles the person has played are offered: if they
  erase their history a puzzle is new again, and replaying how it is solved would spoil it.
- Code: `agent-player.mjs` (the job, the tools and the recording), `client/watch.mjs` (the dialogs and the
  banner), `client/stage.mjs` (plays steps into the page at a pace; tested with a fake page and a virtual
  clock) and `client/page-control.mjs` (drives the picker and the prompt through the page's own form and
  events). The playground was not changed for this.

## Testing with local models (Ollama)

`make llm-eval` (`playground-plus/eval/run.mjs`, using the agent loop in `playground-plus/agent/`) measures how
well a model writes puzzles through the MCP server. It is opt-in: nothing else (`make all`, `make test`, the
server, the MCP server) needs Ollama. Like the other explicit targets it fails loudly with a clear message
(exit status 2) if Ollama is not reachable, a requested model is not installed, or the WebAssembly build is
missing. Its own tests use a scripted fake Ollama server, so they run everywhere; so do the tests of the
generator and the agent player.

```
make llm-eval                                   # qwen3.5:9b and gemma4:12b, 3 trials each
make llm-eval MODELS=devstral:24b TRIALS=1
node playground-plus/eval/run.mjs --list        # installed models and their capabilities
```

For each model and trial, an agent (a stand-in for a chat client) is given the server's tools and instructions
and the task "Please write me a new Bo puzzle", and runs until a puzzle is accepted, it stops calling tools, or
a turn or time limit is hit. The MCP server and the harness are the real ones, on a throwaway database.
Transcripts (every message, tool call and result, and the accepted puzzle) and a summary are written to
`playground-plus/data/eval/<time>/` (git-ignored).

Things the runner gets right on purpose: Ollama's default context window would silently cut the 8 KB guide, so
`num_ctx` is set to 16,384; models that support thinking get a setting that keeps it short (`gpt-oss` low,
`qwen3` off), and models without it are not sent the setting; a tool call written as JSON text instead of the
structured field is counted separately (`calls s/t` in the table) and, by default, accepted (`--no-lenient`
turns that off); tool results are capped at 20,000 characters.

Measured per model: puzzles accepted, valid on the first try, read the guide first, turns, validate calls and
attempts needed, structured and text tool calls, tool errors, seconds and output tokens. Whether an accepted
puzzle is a *good* puzzle still needs a human reading the transcripts.

### What the experiments showed

Each model was run through the real server with a throwaway database; the numbers are puzzles accepted over
trials (small samples, so read them as findings, not statistics). The first experiments had the agent write
the whole Bo file; they led to the spec format and `get_brief`. The default models are `qwen3.5:9b` and
`gemma4:12b`, a size that fits a 10 to 16 GB GPU (the intended minimum setup: no paid online agent needed;
measured on a 10 GB RTX 3080).

**Writing puzzles with specs and briefs** (each trial is a new player, so the brief differs):

| model | accepted | seconds per puzzle | what happened |
|---|---|---|---|
| qwen3.5:9b, thinking off | 11/11 (5, then 6) | about 8 | guide, brief, validate, submit; one trial needed a second validate |
| qwen3.5:9b, thinking on | 1/4 | 200 and more | the model reasoned for 12,000 tokens, filled the context and answered nothing, or looped on `ifte` mistakes |
| gemma4:12b | 5/6 (and 3/4 before the last fixes) | about 15 | the failure was an empty reply (no tool call, no text); a client would simply ask again |

**Writing the whole Bo file** (the earlier design):

| model | accepted | what happened |
|---|---|---|
| qwen2.5-coder:1.5b | 0/3 | invents a "New Puzzle" tool and never calls a real one |
| qwen3:14b (think off) | 0/2 | follows the workflow and writes a *valid* puzzle at once, but returns the guide's example reworded; the novelty check refuses it, and it keeps trying the same idea |
| gpt-oss:20b (think low) | 1/2 | guide, profile, then drafts; the accepted puzzle is new ("Add Three"), after 11 attempts; the other trial ran out of turns on arithmetic slips |

**Playing puzzles** (the agent player; a few trials on four small puzzles, so only indicative): `gemma4:12b`
with thinking on solved 1 of 4 in one run and 2 of 3 in another, with single moves sometimes taking the whole
2 minutes; with thinking off it never solved one, repeating the same line to the turn limit; `qwen3.5:9b`
(thinking off) solved 2 of 4, and 1 of 3 on a `define` puzzle, where it kept running a malformed definition.
Models write puzzles much better than they play them, and `define` puzzles are the hardest.

Lessons, each of which changed the system:

- **Valid is not new.** The first runs were 3/3 "accepted", all copies of a guide example. A novelty check is
  now part of validation (goal, and the spec's kind, inputs and solution), and the guide says "make it your
  own". With a server-chosen idea (the brief), small models carry it out instead of copying.
- **The mechanics were the problem, not the creativity.** Header counts, quoting, the check and above all the
  expected values (arithmetic slips) sank the file format. With specs the server derives all of that by
  running the model's solution; the remaining errors are about Bo itself.
- **Models spiral into lookups.** An unbounded reference tool made a 14B model read documentation for every
  turn. `get_bo_reference` is now searchable and capped, with a nudge after 3 lookups and a refusal after 4
  until a validate.
- **Context and thinking.** Ollama silently drops old messages past its window; the runner sets 16k and flags
  a run that nearly fills it. A thinking model can fill that window with reasoning and answer nothing, so
  `qwen3` models run with thinking off (`modelTraits`).
- **Feedback decides how fast a model converges.** Models ignore a repeated message, so the server says when
  the same puzzle is validated twice. Failures are explained: an op that does not exist (`if`, `then`)
  points to `ifte` and to `get_bo_reference`; `ifte` errors show the order of its three quotations; a failure
  on every input is reported once; "the inputs do not tell wrong from right" shows what the solution gave,
  which is how a model notices that its solution (`0 -`) is not the negation it meant.
- **Where a model is weakest.** The 9B model fails on conditionals (`ifte` order), on `map` (callbacks get a
  unit), and on telling a stack with several numbers from a stack holding a list. The brief therefore gives
  the Bo ops the idea probably needs (`ops`), a new player gets only level 1 topics, and the guide
  explains `ifte`, recursion by name and the list case.
- **Accepted is not good.** A puzzle can be valid and still dull: with the brief's level 1 ideas, many are a
  single op (`swap`, `over`, `+`). That suits a new player and is not a defect, but difficulty and variety
  need real play data.

Not run: devstral:24b, qwen3-coder:30b and gpt-oss:20b on specs (outside the 10 to 16 GB target or too slow
here).

## Limits and open points

- **Model capability.** Bo is a rare language, so weak models write invalid puzzles and play badly. The
  mitigations are the guide, the validator's feedback loop and the server-chosen brief. Whether a puzzle is
  good, and how hard it really is, needs human play; the difficulty the compiler assigns is a crude estimate
  from the solution's length and has not been calibrated.
- **Hidden answers are cosmetic.** The reference program can be kept out of the machine; the expected value
  cannot, because the validator needs it, and the play state lives on ordinary hidden stacks, so a player can
  forge it (for example `2 (puzzle.last) PUSH` reads as solved). Like the visible answers, this is an honour
  system. The agent player refuses the lines that name `puzzle.` or `reveal`.
- **Operation constraints cannot be enforced** by a validator, which only sees the final state (it cannot tell
  `rot` from `clear 3 2 1`). In the PG, puzzles are either submit-style (the validator checks a submitted
  program's ops, as puzzle 09 does) or rely on the player's honesty, and puzzles 07 and 08 say so. An
  allowed-op gate on prompt input (it could use `tokens.mjs`) is not built.
- **Local safety.** The server binds to loopback, checks Host and Origin, serves a whitelist, and the page
  renders puzzle text as plain text, with paired backticks for code.
- **Specs are small.** Whole numbers and lists of them, two kinds. The placeholders (`predict`, `fix`, `golf`,
  `named-stack`) are registered but not offered.
- **Not built:** play tools for agents over MCP and an independent agent solve to estimate difficulty; a
  human-versus-agent comparison on the same puzzle; streaming a model's words while it thinks; replaying a
  person's own session (its events have the same times, so the same replay would work); an HTTP transport for
  MCP, MCP sampling, a standing agent and a stock of puzzles written ahead; export, import and sharing of
  puzzles.
- **Puzzles stored before a change keep their old text** (for example, puzzles written before every
  description ended with "Run `guess` to check your solution." do not have the line).

