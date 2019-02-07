const https = require('https')
const axios = require('axios')
const assign = require('assign-deep')

const log = require('../utils/logger.js')
const config = require('../config.js')

const lxdStatus = {
    created:    100,
    started:    101,
    stopped:    102,
    running:    103,
    canceling:  104,
    pending:    105,
    starting:   106,
    stopping:   107,
    aborting:   108,
    freezing:   109,
    frozen:     110,
    thawed:     111,
    success:    200,
    failure:    400,
    cancelled:  401
}

var exports = module.exports = {}

var agent = new https.Agent({ 
    key: config.clientKey, 
    cert: config.clientCert,
    rejectUnauthorized: false
})

function getUrl (endpoint, resource) {
    return endpoint + '/1.0' + (resource ? ('/' + resource) : '')
}

async function wrapLxdResponse (endpoint, promise) {
    let response
    try {
        response = await promise
    } catch (ex) {
        log.debug('LXD error', ex.response && ex.response.data)
        throw ex
    }
    let data = response.data
    if (typeof data === 'string' || data instanceof String) {
        return data
    } else {
        switch(data.type) {
            case 'sync':
                if (data.metadata) {
                    if (data.metadata.err) {
                        throw data.metadata.err
                    }
                    return data.metadata
                } else {
                    return data
                }
            case 'async':
                log.debug('Forwarding:', data.operation + '/wait')
                return await wrapLxdResponse(endpoint, axios.get(endpoint + data.operation + '/wait', { httpsAgent: agent }))
            case 'error':
                log.debug('LXD error', data.error)
                throw data.error
        }
    }
}

function callLxd(method, endpoint, resource, data, options) {
    let axiosConfig = assign({
        method: method,
        url: getUrl(endpoint, resource),
        httpsAgent: agent,
        data: data,
        timeout: config.lxdTimeout
    }, options || {})
    log.debug(method, axiosConfig.url, data || '')
    return wrapLxdResponse(endpoint, axios(axiosConfig))
}

exports.get = function (endpoint, resource, options) {
    return callLxd('get', endpoint, resource, undefined, options)
}

exports.delete = function (endpoint, resource, options) {
    return callLxd('delete', endpoint, resource, undefined, options)
}

exports.put = function (endpoint, resource, data, options) {
    return callLxd('put', endpoint, resource, data, options)
}

exports.post = function (endpoint, resource, data, options) {
    return callLxd('post', endpoint, resource, data, options)
}
