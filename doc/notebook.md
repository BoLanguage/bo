# Jupyter notebook

The optional Bo Jupyter kernel runs the Python reference implementation. It
keeps one machine for the lifetime of a notebook, loads `include/core.bo` at
startup (a notebook that wants the standard library starts with
`"include/std.bo" require`, which resolves from the kernel's checkout), and
displays the default stack after each successful cell. Use normal
Bo stream operations for output; uncaught Bo errors become Jupyter errors with
their Bo source location. A cell is not a source file, so `__` ops in a cell are
ordinary public ops (see [private ops](language.md#private-ops)); the standard
library's own helpers are private, because `std.bo` is loaded as a file.

From a checkout, install the optional dependencies (`make deps` does this, and
installs the npm packages of the web and editor extensions too) and register the
kernel:

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r pyproject.toml --extra jupyter
.venv/bin/python -m python.bo.jupyter --install --user
```

Start Jupyter Lab or Notebook from that environment, then choose the **Bo**
kernel. The installed kernelspec records the absolute path to the checkout's
kernel launcher, so run the installation command again after moving the
checkout. If `.venv` already exists, omit the `uv venv` command.

### Working with notebooks in VS Code

With the VS Code Jupyter extension installed, select **Bo** from the notebook
kernel picker. If VS Code starts a Python kernel instead, choose **Select
Another Kernel...**, then **Jupyter Kernel...**, and select **Bo**; do not
choose it from **Python Environments...**. Restart the notebook kernel after
changing the selection.

## Syntax highlighting

The JupyterLab frontend extension supplies Bo syntax highlighting for notebook
cells and `.bo` files. From the repository root, install its Node dependencies
and install the extension into the same virtual environment:

```sh
npm install --prefix jupyterlab
PATH="$PWD/.venv/bin:$PATH" uv pip install --python .venv/bin/python -e ./jupyterlab
```

Restart JupyterLab after the editable install. The extension is generated from
the same runtime primitive and adapter data as the VS Code TextMate grammar:
run `python3 tools/generate_vscode_grammar.py` after changing those definitions,
then reinstall the editable extension.

For example, the following cell displays `(3)`:

```bo
1 2 +
```

Cells preserve the default stack and named definitions:

```bo
(dup *) (square) PUSH
5 square
```

The default-stack display is automatic. To inspect a named stack explicitly,
use `snapshot`, for example `(square) snapshot`.

To disable the automatic default-stack display, reinstall the kernel with:

```sh
.venv/bin/python -m python.bo.jupyter --install --user --no-show-stack
```

Restart the kernel afterward. Explicit output, such as `ps`, is unaffected.

The kernel reports an incomplete cell for unmatched opening parentheses, so
Jupyter continues the input instead of executing it early.

## Debugging in a notebook

A notebook cannot pause a program between cells, so the debugging ops behave
differently here from the native prompt (see [debugging](debugging.md)).

- `@` shows where the cell is and goes on. The cell's output gets the user op
  that is running, the stack and the next item:

  ```
  breakpoint in succ_debug
    stack: 2 1
    next: +
  ```

  `@if` (from the standard library: start the notebook with
  `"include/std.bo" require`) shows it only when the value on top of the stack is
  true, which makes it a conditional "print the state here". To turn the display
  off, reinstall the kernel with `--no-breakpoints`, or set `BoKernel.breakpoints`
  to `False`; `@` then does nothing.
- `watch`, `trace` and `where` work as usual: `watch` and `trace` write to
  standard error, which a notebook shows in its own block, and `where` prints the
  programs being run.
- `break-on-error` prints what failed, and the error then ends the cell as any
  uncaught error does; it cannot stop there for you to look around.
- `step`, `next`, `continue` and `stop` raise `Debug-Error`: there is no paused
  program to resume.

Not available yet: pausing a cell at `@` so that the next cells run at that point
on the same stacks and the ops above resume it, and the JupyterLab debugger
panel (breakpoints set in cells, a call stack and a view of the stacks). Both are
possible with the kernel's explicit control stack, but they are larger pieces of
work; for now use the native prompt (`bo --debug`) or the playground to step
through a program.

