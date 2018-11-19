#!/usr/bin/env bash
source /etc/pit_info
cd "${PIT_WORK_DIR:=/data}"
if [ -f "$PIT_RUN_SCRIPT" ]; then
    bash "$PIT_RUN_SCRIPT" >"${PIT_LOG_FILE:=/var/log/run.log}"
fi
# shutdown 0