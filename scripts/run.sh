cd "${JOB_DIR}/src"
# sudo -u snake
nohup bash -c "bash '${JOB_DIR}/src/.compute' > '${JOB_DIR}/process_${GROUP_INDEX}_${PROCESS_INDEX}.log' 2>&1 ; echo \$? > '${JOB_DIR}/exit-status_${GROUP_INDEX}_${PROCESS_INDEX}'" &
echo "pid:$!"