var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var cheerio = require('cheerio');
var walkSync = require('walk-sync');
var mapSeries = require('promise-map-series');
var Writer = require('broccoli-writer');
var helpers = require('broccoli-kitchen-sink-helpers');

// Asset bundling plugin.
//
// Takes just a tree, and rewrites script and stylesheet link-tags, bundling
// all contents into a single file. Tags that list non-existant files or
// external URLs are kept as-is.
//
// The JavaScript and CSS bundles are named after the HTML file, with a
// different extension. All other JavaScript and CSS files are discarded.
//
// An optional second argument is a list for regular expressions for JavaScript
// and CSS files to preserve.
//
// This plugin does not account for alternative stylesheets, or media queries
// in link-tag attributes.
var BundleAssets = function(tree, preserve) {
    if (!(this instanceof BundleAssets))
        return new BundleAssets(tree, preserve);

    this.tree = tree;
    this.preserve = preserve || [];
};
BundleAssets.prototype = Object.create(Writer.prototype);

var htmlRe = /\.html$/;
var discardRe = /\.(js|css)$/;
var isUrlRe = /^\w+:\/\//;

BundleAssets.prototype.write = function(readTree, dst) {
    var self = this;
    return readTree(self.tree)
    .then(function(src) {
        return mapSeries(walkSync(src), function(p) {
            var i = path.join(src, p);
            var o = path.join(dst, p);

            // Rebuild directories in the output.
            if (p.slice(-1) === '/')
                return mkdirp.sync(o);

            // Process HTML files.
            if (htmlRe.test(p))
                return self.processHtml(i, o, src);

            // Discard JS and CSS files.
            var match = self.preserve.some(function(re) {
                return re.test(p);
            });
            if (match || !discardRe.test(p))
                return helpers.copyPreserveSync(i, o);
        });
    });
};

BundleAssets.prototype.processHtml = function(i, o, iRoot) {
    var file, tag;

    var name = path.basename(i).replace(htmlRe, '');
    var iBase = path.dirname(i);
    var oBase = path.dirname(o);

    var html = fs.readFileSync(i, 'utf-8');
    var $ = cheerio.load(html);

    // Walk elements matching the selector, and look for the files in the given
    // attribute. The result is a list of tags and their files' contents.
    function collectFiles(sel, attr, cb) {
        var files = [];
        var tags = $(sel).filter(function() {
            var s = $(this).attr(attr);

            if (!s || isUrlRe.test(s))
                return false;

            var f = s;
            if (s.charAt(0) === '/')
                f = path.join(iRoot, s);
            else
                f = path.join(iBase, s);

            if (!fs.existsSync(f))
                return false;

            files.push({
                path: f,
                data: fs.readFileSync(f, 'utf-8')
            });
            return true;
        });
        cb(tags, files);
    }

    // Bundle all js content and create a new script tag.
    collectFiles('script', 'src', function(tags, files) {
        if (tags.length === 0) return;
        tags.remove();

        var file = name + '.js';
        var data = files.map(function(f) { return f.data; }).join('\n');
        fs.writeFileSync(path.join(oBase, file), data);

        var tag = $('<script/>')
            .attr('src', file);
        $('body').append(tag);
    });

    // Bundle all css content and create a new link tag.
    collectFiles('link[rel="stylesheet"]', 'href', function(tags, files) {
        if (tags.length === 0) return;
        tags.remove();

        var file = name + '.css';
        var data = files.map(function(f) {
            // Rewrite relative URLs.
            var dir = path.dirname(f.path);
            return f.data.replace(/url\(\s*['"]?(.+?)['"]?\s*\)/g, function(match, ref) {
                if (ref[0] === '/' || /https?:/.test(ref)) return match;
                ref = path.resolve(dir, ref);
                ref = path.relative(iBase, ref);
                return 'url(' + JSON.stringify(ref) + ')';
            });
        }).join('\n');
        fs.writeFileSync(path.join(oBase, file), data);

        var tag = $('<link/>')
            .attr('rel', 'stylesheet')
            .attr('href', file);
        $('head').append(tag);
    });

    // Write processed HTML.
    fs.writeFileSync(o, $.html());
};

module.exports = BundleAssets;
