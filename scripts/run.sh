cd "${JOB_DIR}/src"
computescript="${JOB_DIR}/src/.compute"
logfile="${JOB_DIR}/process_${GROUP_INDEX}_${PROCESS_INDEX}.log"
exit_status_file="${JOB_DIR}/exit-status_${GROUP_INDEX}_${PROCESS_INDEX}"
#INCLUDE jail.sh
jail nohup bash -c "bash \"$computescript\" ; echo \$? > \"$exit_status_file\"" >> $logfile 2>&1 &
echo "pid:${JOB_NUMBER}_${GROUP_INDEX}_${PROCESS_INDEX}"