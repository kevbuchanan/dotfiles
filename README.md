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
