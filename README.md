# Kevin's Dotfiles

```bash
$ git clone https://github.com/kevinbuch/dotfiles
$ cd dotfiles
$ ./activate.rb
```

## Homebrew Packages

- Install [Homebrew](https://brew.sh/)
- `cat brew.txt | xargs brew install`

## vim-plug

For vim:

```bash
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

nvim +PlugInstall +qall
```

For neovim:

```bash
sh -c 'curl -fLo "${XDG_DATA_HOME:-$HOME/.local/share}"/nvim/site/autoload/plug.vim --create-dirs \
       https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim'

nvim +PlugInstall +qall
```

## nvim

`vimrc` is both `~/.vimrc` and nvim's `init.vim`. `vimrc.coc` holds the coc.nvim setup and loads last, so its mappings win a conflict. The leader key is `\`.

nvim only:

- nvim-tree replaces NERDTree, and gitsigns marks changed lines in the sign column. diffview.nvim shows a whole diff in one tab. In a fleet's notes folder, nvim-tree shows each task note's status as an icon in the sign column, and the command line shows a note's details when the cursor is on it ([fleet](fleet/README.md#note-state-in-nvim)). render-markdown.nvim draws markdown in the buffer: headings, checkboxes, tables and code blocks. The cursor line and insert mode show the raw text.
- Every second, nvim reloads any unmodified buffer whose file changed on disk, so edits from Claude Code or other tools show up without a focus change. A buffer with unsaved edits gets nvim's normal conflict prompt.
- The prose commands below.

### Files and search

| Keys | Action |
| --- | --- |
| `<C-n>` | toggle the file tree: nvim-tree in nvim, NERDTree in vim |
| `\t` | fzf file picker (`:Files`) |
| `\g` | ripgrep search with fzf (`:Rg`) |
| `<C-h>` `<C-j>` `<C-k>` `<C-l>` | move to the split on the left, below, above or right |

### Editing

| Keys | Action |
| --- | --- |
| `\v` | toggle paste mode |
| `\x` | toggle the first markdown checkbox on the line between `[ ]` and `[x]` |
| `ga` (normal), `<Enter>` (visual) | align with vim-easy-align |
| `:W` | same as `:w` |
| `:RenderMarkdown toggle` | switch a markdown buffer between rendered and raw |

### Tests

vim-test runs tests in a neoterm split.

| Keys | Action |
| --- | --- |
| `t<C-n>` | test nearest |
| `t<C-f>` | test file |
| `t<C-s>` | test suite |
| `t<C-l>` | rerun the last test |
| `t<C-g>` | open the last test file |

### Code (coc.nvim)

| Keys | Action |
| --- | --- |
| `<Tab>`, `<S-Tab>` (insert) | next and previous completion item |
| `<CR>` (insert) | confirm the selected completion |
| `<C-Space>` (insert) | open completion |
| `[g`, `]g` | previous and next diagnostic |
| `gd`, `gy`, `gi`, `gr` | definition, type definition, implementation, references |
| `K` | show documentation |
| `\rn` | rename the symbol |
| `\f` | format the selection or motion |
| `\a` | code action for the selection or motion, such as `\aap` |
| `\ac` | code action for the buffer |
| `\qf` | apply the quick fix for the current line |
| `\cl` | run the code lens action on the current line |
| `if`, `af`, `ic`, `ac` | function and class text objects |
| `<C-f>`, `<C-b>` | scroll a floating window, when one is open |
| `<C-s>` | expand the selection range |
| `<Space>a` `e` `c` `o` `s` | coc lists: diagnostics, extensions, commands, outline, workspace symbols |
| `<Space>j`, `<Space>k`, `<Space>p` | next and previous list item, and resume the last list |
| `:Format`, `:Fold`, `:OR` | format the buffer, fold, organize imports |

### Agents

| Command | Action |
| --- | --- |
| `\s` | run `fleet status` from a pane inside a fleet |
| `:FleetDiff[!] [task \| seat]`, `\d` | open changes as a unified diff, `fleet diff` through delta in a terminal tab: a task's, or a worker's whole branch. `!` opens them side by side in diffview. With no argument, the branch of the worker the current buffer belongs to. See [fleet](fleet/README.md#reviewing-progress). |
| `:FleetBoard [fleet]` | list a fleet's tasks with their status, worker and todos, with keys to open, diff, bump and follow up. See [fleet](fleet/README.md#note-state-in-nvim). |
| `:FleetFollowUp[!] [id] [title]` | from a closed task's note, create a follow-up task and open it, or open the follow-up no worker has taken yet. `!` creates another. See [fleet](fleet/README.md#follow-up-work). |
| `:FleetAssign [seat]` | from a task note with its Todo filled in, assign it, by default to the seat that did the task it follows |
| `:[range]FleetComment [text]`, `\m` | add a review comment on the line or selection to the task's note, from `:FleetDiff!` or a worker's file. See [fleet](fleet/README.md#review-comments). |
| `:FleetReview [task]` | send the task's review comments to its worker with `fleet bump` |
| `:FleetPair [task]` | open window `<task>-pair` in the task's checkout, nvim on the left and an interactive claude on the right that has read the task's note. With no task, the current note, the `:FleetDiff!` tab's task, or the current file's worker. See [fleet](fleet/README.md#working-in-a-workers-checkout). |
| `:FleetShell [seat] [cmd]` | open or switch to a tmux window in a worker's worktree, running `cmd` or a shell. With no seat, the worker the current buffer belongs to. See [fleet](fleet/README.md#working-in-a-workers-checkout). |
| `:FleetBump [task]`, `\b` | save the task note and tell its worker the note has new work. See [fleet](fleet/README.md#follow-up-work). |
| saving a task note | runs `fleet answer` for it, which wakes a worker waiting on a question once none is left open |
| `:Prose [session]` | open a [prose](prose/README.md) review of the current file |
| `:Prose!` | open the review in a new Claude pane |
| `:ProseStop` | stop the prose server for the current file |
| `:ProseList` | list running prose servers |

### Plugins

`\1` reloads `vimrc` and runs `:PlugInstall`.
