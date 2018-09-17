#INCLUDE jail.sh

function ts () {
    while IFS= read -r line; do printf '[%s][%1u.%02u] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" $GROUP_INDEX $PROCESS_INDEX "$line"; done
}

jail "bash -c \"\
      echo \\\"Running compute script...\\\"; \
      bash -ex ../compute.sh; \
      echo \\\$? >../exit-status_${GROUP_INDEX}_${PROCESS_INDEX}; \
      echo \\\"Finished compute script.\\\"; \
      sleep $EXTRA_WAIT_TIME;\"" \
      2>&1 | ts >>"${JOB_DIR}/process_${GROUP_INDEX}_${PROCESS_INDEX}.log" &

echo "pid:${JOB_NUMBER}_${GROUP_INDEX}_${PROCESS_INDEX}"
