# Fixed Coordinator session. cwd /channel. No redirects: d485b6c aborted on 2>/dev/null.
# Prints only the lines the model needs.
echo "== status / free backend =="
jq '{channel,me,head,unread,freeBackend:[.members[]|select(.role=="backend" and .load.level=="free")|.name],members:[.members[]|{name,role,load:.load.level,doing:[.load.current[].id]}]}' status.json

echo "== open tasks per owner =="
for f in tasks/T*.md; do
  state=$(sed -n '2p' "$f")
  case "$state" in
    *"state: done"*) continue ;;
  esac
  sed -n '1,2p' "$f"
done

echo "== unanswered questions =="
awk '
  /^waiting on you / { p=1; print; next }
  /^your unanswered questions / { p=1; print; next }
  p && /^  / { print; next }
  p { p=0 }
' status

echo "== cross-channel tasks =="
# The current channel is a symlink to /channel. Skip a glob that did not match,
# so this section lists other channels and does not treat the literal pattern as a file.
for dir in /channels/*; do
  [ -d "$dir" ] || continue
  [ "$(readlink "$dir")" = "/channel" ] && continue
  echo "## $(basename "$dir")"
  for f in "$dir"/tasks/T*.md; do
    [ -f "$f" ] || continue
    state=$(sed -n '2p' "$f")
    case "$state" in
      *"state: done"*) continue ;;
    esac
    sed -n '1,2p' "$f"
  done
done
