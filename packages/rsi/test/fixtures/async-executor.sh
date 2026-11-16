case "$1" in
  submit)
    count=0
    if test -f "$3/submits"; then count=$(cat "$3/submits"); fi
    printf '%s\n' "$((count + 1))" > "$3/submits"
    printf '%s\n' "${4}" > "$3/seed"
    printf '0\n' > "$3/polls"
    printf 'job with spaces;literal\n'
    ;;
  get)
    test "$3" = 'job with spaces;literal' || exit 8
    n=$(cat "$2/polls")
    n=$((n + 1))
    printf '%s\n' "$n" > "$2/polls"
    if test "$n" -lt 2; then
      printf '{"state":"running"}\n'
    else
      seed=$(cat "$2/seed")
      printf '{"metrics":{"score":%s}}\n' "$seed" > "$2/metrics.json"
      printf '{"state":"done","exitCode":0}\n'
    fi
    ;;
  cancel)
    printf '%s\n' "$3" > "$2/cancelled"
    ;;
esac
