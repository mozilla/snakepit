nohup bash $JOB_DIR/src/.compute > $JOB_DIR/process_$PROCESS_INDEX.log 2>&1 &
echo "pid:$!"