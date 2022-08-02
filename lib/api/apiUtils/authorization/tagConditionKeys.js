const assert = require('assert');
const async = require('async');
const { auth, s3middleware } = require('arsenal');
const metadata = require('../../../metadata/wrapper');
const { decodeVersionId } = require('../object/versioning');

const { parseTagXml } = s3middleware.tagging;

function makeTagQuery(tags) {
    return Object.entries(tags)
        .map(i => i.join('='))
        .join('&');
}

function updateRequestContexts(request, requestContexts, apiMethod, log, cb) {
    async.waterfall([
        next => {
            if (request.headers['x-amz-tagging']) {
                return next(null, request.headers['x-amz-tagging']);
            }
            if (request.post && apiMethod === 'objectPutTagging') {
                return parseTagXml(request.post, log, (err, tags) => {
                    if (err) {
                        log.trace('error parsing request tags');
                        return next(err);
                    }
                    return next(null, makeTagQuery(tags));
                });
            }
            return next(null, null);
        },
        (requestTagsQuery, next) => {
            const objectKey = request.objectKey;
            const bucketName = request.bucketName;
            const decodedVidResult = decodeVersionId(request.query);
            if (decodedVidResult instanceof Error) {
                log.trace('invalid versionId query', {
                    versionId: request.query.versionId,
                    error: decodedVidResult,
                });
                return next(decodedVidResult);
            }
            const reqVersionId = decodedVidResult;
            return metadata.getObjectMD(
                bucketName, objectKey, { versionId: reqVersionId }, log, (err, objMD) => {
                    if (err) {
                        // TODO: move to `.is` once BKTCLT-9 is done and bumped in Cloudserver
                        if (err.NoSuchKey) {
                            return next(null, requestTagsQuery, null);
                        }
                        log.trace('error getting request object tags');
                        return next(err);
                    }
                    const existingTagsQuery = objMD.tags && makeTagQuery(objMD.tags);
                    return next(null, requestTagsQuery, existingTagsQuery);
                });
        },
    ], (err, requestTagsQuery, existingTagsQuery) => {
        if (err) {
            log.trace('error processing tag condition key evaluation');
            return cb(err);
        }
        for (const rc of requestContexts) {
            rc.setNeedTagEval(true);
            if (requestTagsQuery) {
                rc.setRequestObjTags(requestTagsQuery);
            }
            if (existingTagsQuery) {
                rc.setExistingObjTag(existingTagsQuery);
            }
        }
        return cb(null, requestContexts);
    });
}

function tagConditionKeyAuth(authorizationResults, request, requestContexts, apiMethod, log, cb) {
    if (!authorizationResults) {
        return cb();
    }
    if (!authorizationResults.some(authRes => authRes.checkTagConditions)) {
        return cb();
    }

    return updateRequestContexts(request, requestContexts, apiMethod, log, (err, updatedContexts) => {
        if (err) {
            return cb(err);
        }
        if (assert.deepStrictEqual(requestContexts, updatedContexts)) {
            return cb();
        }
        return auth.server.doAuth(request, log,
            (err, userInfo, tagAuthResults) => cb(err, tagAuthResults), 's3', updatedContexts);
    });
}

module.exports = {
    tagConditionKeyAuth,
    updateRequestContexts,
    makeTagQuery,
};
