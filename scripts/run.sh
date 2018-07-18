computescript="${JOB_DIR}/src/.compute"
logfile="${JOB_DIR}/process_${GROUP_INDEX}_${PROCESS_INDEX}.log"
exit_status_file="${JOB_DIR}/exit-status_${GROUP_INDEX}_${PROCESS_INDEX}"
descriptor=".compute script (process ${GROUP_INDEX}.${PROCESS_INDEX})"

#INCLUDE jail.sh

function ts () {
    while IFS= read -r line; do printf '[%s][%1u.%02u] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" $GROUP_INDEX $PROCESS_INDEX "$line"; done
}

jail bash -c "echo \"Running $descriptor...\" ;\
              cd \"${JOB_DIR}/src\" ;\
              bash \"$computescript\" ;\
              echo \$? >\"$exit_status_file\" ;\
              echo \"Finished $descriptor.\" ;\
              sleep $EXTRA_WAIT_TIME" \
    2>&1 | ts >>"$logfile" &
echo "pid:${JOB_NUMBER}_${GROUP_INDEX}_${PROCESS_INDEX}"