while true; do
	ps -o pid= | sed 's/^ *//;s/ *$//' | sed 's/.*/pid:&/'
    nvidia-smi --query-gpu=utilization.gpu,utilization.memory --format=csv,noheader | awk '{printf "util:cuda%d,%s\n", NR-1, $0}' | sed -e "s/ %//g" | sed -e "s/ //g"
    echo "NEXT"
    sleep $INTERVAL
done