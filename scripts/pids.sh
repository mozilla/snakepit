ps -o pid= | sed 's/^ *//;s/ *$//' | sed 's/.*/pid:&/'
nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,utilization.memory --format=csv,noheader | awk '{printf "cuda: %d, %s\n", NR-1, $0}'