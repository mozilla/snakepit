#!/usr/bin/env bash

cuda_index=0
if [ -d /proc/driver/nvidia/gpus ]; then
    for gpu_dir in /proc/driver/nvidia/gpus/*/ ; do
        model=`awk -F: '/Model/{gsub(/^[ \t]+/, "", $2);gsub(/[,]/, " ", $2);print $2}' "${gpu_dir}/information"`
        echo "resource:cuda,${cuda_index},${model}" >>"$RESULT_FILE"
        ((cuda_index++))
    done
fi
