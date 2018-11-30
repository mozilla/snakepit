#!/usr/bin/env bash

echo "Scanning node for resources..."
if [ -d /proc/driver/nvidia/gpus ]; then
    cuda_index=0
    for gpu_dir in /proc/driver/nvidia/gpus/*/ ; do
        model=`awk -F: '/Model/{gsub(/^[ \t]+/, "", $2);gsub(/[,]/, " ", $2);print $2}' "${gpu_dir}/information"`
        echo "resource:cuda,${cuda_index},${model}" >>"$RESULT_FILE"
        ((cuda_index++))
    done
    echo "Found ${cuda_index} CUDA device(s)"
fi
echo "Node scanning done"
