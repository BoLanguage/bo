# Planned updates

This list mixes implemented groundwork with possible future work; it is not a
release schedule.

## Implemented groundwork

- **Arrays**. Bo supports multidimensional arrays, broadcasting, reductions, and core linear
  algebra operations. Determinants, matrix inverses, and solving linear
  systems are possible extensions.
- **Process parallelism**. `PARALLEL` is implemented. Its process
  startup and data-transfer overhead can outweigh the work for smaller
  workloads; see the [array benchmarks](benchmarks.md#array-parallel-workloads).

## Possible future work

### Language

- **GPU backends**. Evaluate whether a GPU backend is worthwhile for array
  operations before choosing a design or implementation. The current CPU
  parallel benchmarks show limited benefit for the tested workloads and
  substantial overhead; performance depends on workload size and the cost of
  moving data to and from workers. See the [benchmark notes](benchmarks.md).
- **Asynchronous tasks**. Explore `ASYNC`/`AWAIT` after defining how tasks
  access stacks and word definitions, report errors, and handle cancellation.
- **Profiler**. Consider a simple profiler for Bo.
- **Filesystem operations**. Simple FS integration words (e.g., `cwd`, `cd`, `mkdir`, `rmdir`,
  `cp`, `mv`, `rm`), as well as words to handle absolute/relative paths and compose
  file/directory names. A general `system` operation remains an alternative to evaluate,
  with portability and execution semantics to resolve.
- **Modules and namespaces (low priority)**. Revisit whether a real module
  system would provide enough benefit over Bo's current convention of plain
  words in one shared namespace. This is exploratory, not a commitment to implement one;
  see [open questions](open-questions.md).
- **Time-related words**. Add words to deal with time (e.g., a `TIME` primitive
  than pushes a timestamp, and derived words such as `tic`/`toc` and `timeit`).
- **Pause execution**. Add a primitive `PAUSE` to pause execution and return to 
  toplevel, plus a `RESUME` primitive to resume execution. These should also control 
  the playground switch between Run and Step in the Editor.
  Notably, these primitives would be "degenerate" like `ABORT` (i.e., they would require 
  a stack-selector but don't use it). So, the corresponding default-stack adapters 
  `pause` and `resume` would behave exactly as the primitives, similar to the `abort` wrapper.  
- **Debugging**. - Add words for simple debugging features. 


### Playground

- **Draggable stack elements**, with movements translated to code.
  We could initially allow this only "within-stack" and only for the default stack.
  Such implementation would be a nice addition to the PG(+) puzzles.
  For instance, the system can suggest code that the user has to replicate by dragging 
  items on the stack, or vice versa.

### Playground+

- **New puzzle kinds**. Implement `predict`, `fix`, `golf`, and `named-stack`
  (currently placeholders).

