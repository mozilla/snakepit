while true; do
    ps -e wwe | sed -e 's/.*JOB_NUMBER=\([0-9]\+\).*GROUP_INDEX=\([0-9]\+\).*PROCESS_INDEX=\([0-9]\+\).*/pid:\1_\2_\3/;t;d'
    nvidia-smi --query-gpu=utilization.gpu,utilization.memory --format=csv,noheader | awk '{printf "util:cuda%d,%s\n", NR-1, $0}' | sed -e "s/ %//g" | sed -e "s/ //g"
    echo "NEXT"
    sleep $INTERVAL
done