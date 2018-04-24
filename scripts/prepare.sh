set -e

JOB_DIR="$JOBS_DIR/$JOB_NAME"
mkdir -p "$JOB_DIR"
mkdir -p "$JOB_DIR/tmp"
mkdir -p "$JOB_DIR/keep"

JOB_DATA_DIR="$JOB_DIR/data"
mkdir -p "$JOB_DATA_DIR"
for group in $USER_GROUPS; do
    data_group_dir="$DATA_DIR/$group"
    if [ -d "$data_group_dir" ]; then
        job_data_group_dir="$JOB_DATA_DIR/$group"
        mkdir -p "$job_data_group_dir"
        bindfs -n -r "$data_group_dir" "$job_data_group_dir"
    fi
done

JOB_SRC_DIR="$JOB_DIR/src"

if [ -n "$ORIGIN" ]; then
    mkdir -p "$CACHE_DIR"
    CACHE_ENTRY=`echo -n $ORIGIN | md5sum | cut -f1 -d" "`
    CACHE_REPO="$CACHE_DIR/$CACHE_ENTRY"

    if [ -d "$CACHE_REPO" ]; then
        git -C "$CACHE_REPO" fetch --all >/dev/null
        touch "$CACHE_REPO"
    else
        git clone $ORIGIN "$CACHE_REPO" >/dev/null
    fi

    git -C "$CACHE_REPO" archive --format=tar --prefix=src/ $HASH | (cd "$JOB_DIR" && tar xf -)
    if [ -n "$DIFF" ]; then
        cd "$JOB_SRC_DIR"
        echo "$DIFF" | patch -p0
    fi
elif [ -n "$ARCHIVE" ]; then
    tar -xzf "$ARCHIVE" -C "$JOB_SRC_DIR"
    rm "$ARCHIVE"
fi

