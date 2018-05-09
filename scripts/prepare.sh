set -e

job_dir="$DATA_ROOT/jobs/$JOB_NUMBER"
mkdir -p "$job_dir"
mkdir -p "$job_dir/tmp"

if [ -n "$CONTINUE_JOB_NUMBER" ]; then
    cp -r "$DATA_ROOT/jobs/$CONTINUE_JOB_NUMBER/keep" "$job_dir/keep"
else
    mkdir -p "$job_dir/keep"
fi

job_groups_dir="$job_dir/groups"
mkdir -p "$job_groups_dir"
for group in $USER_GROUPS; do
    data_group_dir="$DATA_ROOT/groups/$group"
    if [ -d "$data_group_dir" ]; then
        job_data_group_dir="$job_groups_dir/$group"
        mkdir -p "$job_data_group_dir"
        bindfs -n -r "$data_group_dir" "$job_data_group_dir"
    fi
done

job_src_dir="$job_dir/src"

if [ -n "$ORIGIN" ]; then
    mkdir -p "$DATA_ROOT/cache"
    cache_entry=`echo -n $ORIGIN | md5sum | cut -f1 -d" "`
    cache_repo="$DATA_ROOT/cache/$cache_entry"

    if [ -d "$cache_repo" ]; then
        git -C "$cache_repo" fetch --all >/dev/null
        touch "$cache_repo"
    else
        git clone $ORIGIN "$cache_repo" >/dev/null
    fi

    git -C "$cache_repo" archive --format=tar --prefix=src/ $HASH | (cd "$job_dir" && tar xf -)
    if [ -n "$DIFF" ]; then
        cd "$job_src_dir"
        echo "$DIFF" | patch -p0
    fi
elif [ -n "$ARCHIVE" ]; then
    tar -xzf "$ARCHIVE" -C "$job_src_dir"
    rm "$ARCHIVE"
fi

