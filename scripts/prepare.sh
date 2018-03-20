set -e

mkdir -p "$CACHE_DIR"
CACHE_ENTRY=`echo -n $ORIGIN | md5sum | cut -f1 -d" "`
CACHE_REPO="$CACHE_DIR/$CACHE_ENTRY"

if [ -d "$CACHE_REPO" ]; then
    git -C "$CACHE_REPO" fetch --all >/dev/null
    touch "$CACHE_REPO"
else
    git clone $ORIGIN "$CACHE_REPO" >/dev/null
fi

JOB_DIR="$JOBS_DIR/$JOB_NAME"
mkdir -p "$JOB_DIR"
JOB_SRC_DIR="$JOB_DIR/src"
git -C "$CACHE_REPO" archive --format=tar --prefix=src/ HEAD | (cd "$JOB_DIR" && tar xf -)
if [ -n "$DIFF" ]; then
    echo $DIFF | git -C "$JOB_SRC_DIR" apply >/dev/null
fi