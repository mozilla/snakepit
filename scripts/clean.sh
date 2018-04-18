JOB_DIR="$JOBS_DIR/$JOB_NAME"
rm -rf "$JOB_DIR/tmp"
JOB_DATA_DIR="$JOB_DIR/data"
for dir in $JOB_DATA_DIR/*; do
    if [[ -d $dir ]]; then
        fusermount -u $dir
    fi
done
rm -rf "$JOB_DIR/data"

