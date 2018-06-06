if [ ! -f "$DATA_ROOT/db.json" ]; then
    echo "Cannot access data root. Please ensure node's remote user can access snakepit's data directory through the same path as on the master node (by NFS or some other file sharing infrastructure)." >&2
    exit 1
fi
grep "^model name" /proc/cpuinfo | sed -e "s/(tm)//gI" -e "s/(r)//gI" -e "s/processor//gI" -e "s/cpu//gI" -e "s/@.*$//" -e "s/ *$//" -e "s/^.*: /cpu:/"
if [ "$(type -t nvidia-smi)" = "file" ]; then
    nvidia-smi --query-gpu=gpu_name --format=csv,noheader | sed -e "s/^/cuda:/"
fi