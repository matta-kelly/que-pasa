---
type: component
description: "que-pasa's sandbox: where a run's file and command tools act, behind one backend interface, after LangChain Deep Agents. Read for what it wraps and why, what each backend's wall stops, the two abilities, the backends and the view, the tools and their replay rules, and where it differs from Deep Agents."
status: running
---
Where a run's tools read, write and run commands: a backend, behind one interface, which the host gives each run. The code is `sandbox/`, exported as `@mku1tra/que-pasa/sandbox`, after LangChain Deep Agents' backends and filesystem tools.
- [[#What it wraps]] the tools' effects, not the agent
- [[#What each wall stops]] the threat model, per backend
- [[#The backend]] two abilities, and one path rule
- [[#The backends]] local, Podman, and a view over either
- [[#The tools]] Deep Agents' seven, and their replay rules
- [[#Where it differs from Deep Agents]]

- [[que-pasa]]: the harness it is part of
- [[define-tool]]: how a tool asks its run for a resource, such as the sandbox

---
## What it wraps

The sandbox wraps the tools' effects; the agent stays in the host process.
- the loop, its storage and the host's credentials are in the host process, so code a tool runs never reaches them
- a crash in the sandbox ends one tool call, not the run: the model gets an error result
- the host gives each run its backend as the `Sandbox` resource ([[define-tool#Reaching an outside system]]), resolved from the run as it was started: a run that resumes in a new process gets the same container
- policy is the host's: which image, which mounts, network, read-only, and each run's view. que-pasa holds none

## What each wall stops

| Threat | local | view | Podman |
|---|---|---|---|
| a path that leaves the root (`..`, absolute, `~`, a control character) | refused: `invalid_path` | refused | refused, and the mounts are the wall |
| a symlink out of the root | not stopped: no wall | not stopped: it checks names | the mounts are the wall |
| a path outside the view | n/a | answered as missing | n/a |
| a write outside the view's write files | n/a | refused: `permission_denied` | n/a |
| a path or content read as a command | none: a path is a positional argument, content goes over stdin | none | none |
| network | the host's | no execute | none, by default |
| host state: storage, credentials, other runs | reachable | reachable below it | only what is mounted |
| a runaway command | the signal kills it | no execute | the signal kills the exec; CPU and memory caps bound it; `close()` ends it |

- local is for the host's own trusted work, and tests
- a view checks names only, so it is a wall only over a backend that is one: a container whose mounts hold no more than its folder
- a view's search reads the files under the path searched, inside the backend, and gives back only its own: a wall below it keeps the rest out
- a view has no execute: a shell reaches any path (Deep Agents: path rules "provide no security with shell access")

## The backend

A backend is the place where a run's files are and its commands run, behind one interface (`sandbox/backend.ts`). Two abilities, as Deep Agents' protocol has them:
- files (`FileBackend`): `ls`, `read`, `write`, `edit`, `glob`, `grep` (literal text, not a pattern)
- commands (`SandboxBackend`): files, plus `execute` and an `id`
- one path rule for every backend (`sandbox/paths.ts`): a path is relative to the backend's root or absolute under it; any other is `invalid_path`. Every path a result gives is relative to the root
- a backend gives its errors back in the result: `file_not_found`, `is_directory`, `invalid_path`, `permission_denied`, and an edit's `string_not_found` and `string_not_unique`. It throws only when it cannot run at all, such as a read-only file system
- `shellBackend(exec)` (`sandbox/shell.ts`) builds a whole sandbox backend on one primitive, a script run in the root, as Deep Agents' `BaseSandbox` does. It needs only POSIX tools, which BusyBox has too. It is the only place files meet a shell
- not built: delete, upload and download. No run needs them yet

## The backends

- `local({ root })`: a folder on the host. Commands run as the host's user
- `podman({ name, image, mounts, workdir, network, user, memory, cpus, runArgs })`: a container that outlives the process; each operation execs into it
	- made on its first call and kept: started again if it stopped, made again if it is gone, so a run that resumes after a host restart needs no host step
	- labelled with a hash of its options: a container of its name made with other options is refused, never used
	- `network` is "none" by default; `close()` removes it
- `view(backend, { read, write })`: a files backend over another, limited to some files
	- a path outside it is answered as missing; a write outside its write files is refused, with the files it may write
	- its search runs once on the backend, and keeps only its own files, as Deep Agents filters its path rules' results. The backend reads the files under the path to search them, and its limit counts them too, so a cut result says it is cut

## The tools

`sandbox/tools.ts`: Deep Agents' tools, with their names, parameters and answers. Each declares `uses: [Sandbox]`, so a host that runs them must provide one.

| Tool | Does | Replay |
|---|---|---|
| `ls` | a folder's files, a folder with a slash | safe |
| `read_file` | `limit` lines (100) after `offset`, under a `@@ lines A-B of T \| next offset N @@` header, verbatim | safe |
| `write_file` | a file, whole, with its folders | safe: twice is once |
| `edit_file` | replace `old_string`, once, or each with `replace_all` | never: a second replace finds nothing, or replaces twice |
| `glob` | files under a path matching a glob, from the root | safe |
| `grep` | lines holding a literal text, by file, in files matching `glob` | safe |
| `execute` | a shell command in the root: its output, then how it ended | never: a command can do anything |

- sets: `readTools` (ls, read_file, glob, grep), `fileTools` (those, write_file and edit_file). `execute` is given on its own
- an answer is cut at 80,000 characters (`maxAnswer`): a listing at a whole line, a read at a whole line with the offset to go on from, a command's output to its tail, where a failure is
- `commandAnswer(result)`: `execute`'s answer, so a host tool that runs a command, such as a test, answers the same way

## Where it differs from Deep Agents

- the backend comes from the run, not the agent: the host provides it per run as a resource, so one agent definition runs in any sandbox, and a run that resumes gets its own back
- a view answers a path outside it as missing, where Deep Agents' path rules answer denied: a model told "missing" keeps to its task, and does not probe
- `execute` is given or not by the agent's tool list, which is fixed; Deep Agents drops it when the backend has none. On a backend with none it answers as Deep Agents does
- every operation is async; errors are codes, and the tools word them as Deep Agents does
