if [ ! "$(type -t curl)" = "file" ]; then
    echo "Missing curl command. This is required for testing basic connectivity to head node." >&2
    exit 1
fi
cert=$(mktemp)
echo "${TEST_CERT}" >$cert
if ! curl --cacert $cert "$TEST_URL" ; then
    echo "Cannot access head node." >&2
    exit 1
fi
rm $cert
# grep "^model name" /proc/cpuinfo | sed -e "s/(tm)//gI" -e "s/(r)//gI" -e "s/processor//gI" -e "s/cpu//gI" -e "s/@.*$//" -e "s/ *$//" -e "s/^.*: /cpu:/"
if [ "$(type -t nvidia-smi)" = "file" ]; then
    nvidia-smi --query-gpu=gpu_name --format=csv,noheader | sed -e "s/^/cuda:/"
fi