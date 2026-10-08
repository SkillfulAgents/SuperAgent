#!/bin/sh
# Installed as /usr/local/bin/git, ahead of /usr/bin/git on PATH.
# A mounted volume shows every file as executable (rclone --file-perms 0777), so in a repo under /mounts
# git would report a mode change on every tracked file. There it ignores the executable bit. Other repos
# run git unchanged. The repo is found from the working folder and -C, the two forms agents use.
dir=$PWD
next=
for arg in "$@"; do
  if [ "$next" = C ]; then
    case $arg in /*) dir=$arg ;; *) dir=$dir/$arg ;; esac
    next=; continue
  fi
  [ "$next" = skip ] && { next=; continue; }
  case $arg in
    -C) next=C ;;
    -c|--config-env|--namespace|--git-dir|--work-tree|--super-prefix|--shallow-file) next=skip ;;
    -*) ;;
    *) break ;;
  esac
done

case $(realpath -m -- "$dir") in
  /mounts/*)
    n=${GIT_CONFIG_COUNT:-0}
    export "GIT_CONFIG_KEY_$n=core.fileMode" "GIT_CONFIG_VALUE_$n=false" "GIT_CONFIG_COUNT=$((n + 1))"
    ;;
esac
exec /usr/bin/git "$@"
