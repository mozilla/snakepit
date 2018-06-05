grep "^model name" /proc/cpuinfo | sed -e "s/(tm)//gI" -e "s/(r)//gI" -e "s/processor//gI" -e "s/cpu//gI" -e "s/@.*$//" -e "s/ *$//" -e "s/^.*: /cpu:/"
if [ "$(type -t nvidia-smi)" = "file" ]; then
    nvidia-smi --query-gpu=gpu_name --format=csv,noheader | sed -e "s/^/cuda:/"
fi