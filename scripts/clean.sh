set -o pipefail
(
echo "Cleaning started..."
set -x
rm -rf "$JOB_DIR/tmp"
rm -rf "$JOB_DIR/src"
echo "Cleaning done."
) 2>&1 | ts '[%Y-%m-%d %H:%M:%S] [clean]' >>"$JOB_DIR/pit.log"