/*!
 * mustache.js — Logic-less {{mustache}} templates with JavaScript
 * http://github.com/janl/mustache.js
 */
var Mustache = (typeof module != "undefined" && module.exports) || {};

(function (exports) {

  exports.name = "mustache.js";
  exports.version = "0.4.0";
  exports.tags = ["{{", "}}"];
  exports.parse = parse;
  exports.compile = compile;
  exports.render = render;
  exports.clearCache = clearCache;

  // For backwards compat.
  exports.to_html = render;

  var _toString = Object.prototype.toString;
  var _isArray = Array.isArray;
  var _forEach = Array.prototype.forEach;
  var _trim = String.prototype.trim;

  function isObject(obj) {
    return _toString.call(obj) == "[object Object]";
  }

  var isArray;
  if (_isArray) {
    isArray = _isArray;
  } else {
    isArray = function (obj) {
      return _toString.call(obj) == "[object Array]";
    };
  }

  var forEach;
  if (_forEach) {
    forEach = function (obj, callback, scope) {
      return _forEach.call(obj, callback, scope);
    };
  } else {
    forEach = function (obj, callback, scope) {
      for (var i = 0, len = obj.length; i < len; ++i) {
        callback.call(scope, obj[i], i, obj);
      }
    };
  }

  var spaceRe = /^\s*$/;

  function isWhitespace(string) {
    return spaceRe.test(string);
  }

  var trim;
  if (_trim) {
    trim = function (string) {
      return string == null ? "" : _trim.call(string);
    };
  } else {
    var trimLeft, trimRight;

    if (isWhitespace("\xA0")) {
      trimLeft = /^\s+/;
      trimRight = /\s+$/;
    } else {
      // IE doesn't match non-breaking spaces with \s, thanks jQuery.
      trimLeft = /^[\s\xA0]+/;
      trimRight = /[\s\xA0]+$/;
    }

    trim = function (string) {
      return string == null ? "" :
        String(string).replace(trimLeft, "").replace(trimRight, "");
    };
  }

  /**
   * Looks up the value of the given `name` in the given context `stack`.
   */
  function findName(name, stack) {
    var context, value;

    var i = stack.length;
    while (i) {
      context = stack[--i];

      if (name in context) {
        value = context[name];
        break;
      }
    }

    // If the value is a function, call it in the current context.
    if (typeof value == "function") {
      value = value.call(stack[stack.length - 1]);
    }

    if (value == null) {
      return "";
    }

    return value;
  }

  /**
   * Returns a bit of code that can be used to find the given `name`.
   */
  function findFor(name) {
    return name == "." ? "stack[stack.length - 1]" : 'find("' + name + '")';
  }

  /**
   * Returns an HTML-safe version of the given `string`.
   */
  function escapeHTML(string) {
    return String(string)
      .replace(/&(?!\w+;)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sendSection(send, value, callback, stack, inverted) {
    if (inverted) {
      // From the spec: inverted sections may render text once based on the
      // inverse value of the key. That is, they will be rendered if the key
      // doesn't exist, is false, or is an empty list.
      if (value == null || value === false || (isArray(value) && value.length == 0)) {
        send(callback());
      }
    } else if (isArray(value)) {
      forEach(value, function (value) {
        stack.push(value);
        send(callback());
        stack.pop();
      });
    } else if (isObject(value)) {
      stack.push(value);
      send(callback());
      stack.pop();
    } else if (typeof value == "function") {
      var scope = stack[stack.length - 1];
      var scopedRender = function (template) {
        return render(template, scope);
      };
      send(value.call(scope, callback(), scopedRender) || "");
    } else if (value) {
      send(callback());
    }
  }

  /**
   * Adds the `template`, `line`, and `file` properties to the given error
   * object and alters the message to provide more useful debugging information.
   */
  function debug(e, template, line, file) {
    file = file || "<template>";

    var lines = template.split("\n"),
        start = Math.max(line - 3, 0),
        end = Math.min(lines.length, line + 3),
        context = lines.slice(start, end);

    var c;
    for (var i = 0, len = context.length; i < len; ++i) {
      c = i + start + 1;
      context[i] = (c == line ? " >> " : "    ") + context[i];
    }

    e.template = template;
    e.line = line;
    e.file = file;
    e.message = [file + ":" + line, context.join("\n"), "", e.message].join("\n");

    return e;
  }

  // The following two snippets of code are used to buffer content while the
  // template is rendering.

  var bufferStart = [
    'var callback = (function () {',
    '  var buffer, send = function (chunk) { buffer.push(chunk); };',
    '  return function () {',
    '    buffer = [];'
  ].join("\n");

  var bufferEnd = [
    '    return buffer.join("");',
    '  };',
    '})();'
  ].join("\n");

  /**
   * Parses the given `template` and returns the source of a function that,
   * with the proper arguments, will render the template. Recognized options
   * include the following:
   *
   *   - file     The name of the file the template comes from (displayed in
   *              error messages)
   *   - tags     An array of open and close tags the `template` uses. Defaults
   *              to the value of Mustache.tags
   *   - debug    Set `true` to print the body of the generated function
   *   - space    Set `true` to preserve whitespace from lines that otherwise
   *              contain only a {{tag}}. Defaults to `false`
   */
  function parse(template, options) {
    options = options || {};

    var tags = options.tags || exports.tags,
        openTag = tags[0],
        closeTag = tags[tags.length - 1];

    var code = [
      [
        "var line = 1;", // keep track of source line number
        "try {",
        'send("'
      ].join("\n")
    ];

    var spaces = [],      // indices of whitespace in code for the current line
        nonSpace = false, // is there a non-space char on the current line?
        hasTag = false;   // is there a content {{tag}} on the current line?

    // Strips all space characters from the code array for the current line
    // if there was a {{tag}} on it and otherwise only spaces.
    var stripSpace = function () {
      if (!hasTag && !nonSpace && !options.space) {
        while (spaces.length) {
          code.splice(spaces.pop(), 1);
        }
      }

      spaces = [];
      nonSpace = false;
      hasTag = false;
    };

    var line = 1, c, sectionStack = [], callback, nextOpenTag, nextCloseTag;
    for (var i = 0, len = template.length; i < len; ++i) {
      if (template.slice(i, i + openTag.length) == openTag) {
        i += openTag.length;
        c = template.substr(i, 1);
        nextOpenTag = openTag;
        nextCloseTag = closeTag;

        // TODO: This switch statement is probably slow. Does it matter?
        switch (c) {
        case "!": // Comment.
          i++;
          callback = null;
          break;

        case "^": // Start "empty variable" section.
          i++;
          callback = function (source) {
            var name = trim(source);

            if (name == "") {
              throw debug(new Error("Section name may not be empty"), template, line, options.file);
            }

            sectionStack.push({name: name, inverted: true});

            return [
              '");',
              'line = ' + line + ';',
              'var value = ' + findFor(name) + ';',
              bufferStart,
              'send("'
            ].join("\n");
          };
          break;

        case "#": // Start section.
          i++;
          callback = function (source) {
            var name = trim(source);

            if (name == "") {
              throw debug(new Error("Section name may not be empty"), template, line, options.file);
            }

            sectionStack.push({name: name});

            return [
              '");',
              'line = ' + line + ';',
              'var value = ' + findFor(name) + ';',
              bufferStart,
              'send("'
            ].join("\n");
          };
          break;

        case "/": // End section.
          i++;
          callback = function (source) {
            var name = trim(source);
            var openName = sectionStack.length != 0 && sectionStack[sectionStack.length - 1].name;

            if (!openName || name != openName) {
              throw debug(new Error('Section named "' + name + '" was never opened'), template, line, file);
            }

            var section = sectionStack.pop();
            var code = [
              '");',
              bufferEnd
            ];

            if (section.inverted) {
              code.push("sendSection(send,value,callback,stack,true);");
            } else {
              code.push("sendSection(send,value,callback,stack);");
            }

            code.push('send("');

            return code.join("\n");
          };
          break;

        case "=": // Change open/close tags, e.g. {{=<% %>=}}.
          i++;
          closeTag = "=" + closeTag;
          callback = function (source) {
            tags = trim(source).split(/\s+/);
            nextOpenTag = tags[0];
            nextCloseTag = tags[tags.length - 1];
            return "";
          };
          break;

        case ">": // Include partial.
          i++;
          callback = function (source) {
            return [
              '");',
              'line = ' + line + ';',
              'var partial = partials["' + trim(source) + '"];',
              'if (partial) {',
              '  send(render(partial, stack[stack.length - 1], partials));',
              '}',
              'send("'
            ].join("\n");
          };
          break;

        case "{": // Plain variable.
          closeTag = "}" + closeTag;
          // fall through

        case "&": // Plain variable.
          i++;
          hasTag = true;
          callback = function (source) {
            return [
              '");',
              'line = ' + line + ';',
              'send(' + findFor(trim(source)) + ');',
              'send("'
            ].join("\n");
          };
          break;

        default: // Escaped variable.
          hasTag = true;
          callback = function (source) {
            return [
              '");',
              'line = ' + line + ';',
              'send(escapeHTML(' + findFor(trim(source)) + '));',
              'send("'
            ].join("\n");
          };
        }

        var end = template.indexOf(closeTag, i);

        if (end === -1) {
          throw debug(new Error('Tag "' + openTag + '" was not closed properly'), template, line, options.file);
        }

        var source = template.substring(i, end);

        if (callback) {
          code.push(callback(source));
        }

        // Maintain line count for \n in source.
        var n = 0;
        while (~(n = source.indexOf("\n", n))) {
          line++;
          n++;
        }

        i = end + closeTag.length - 1;

        openTag = nextOpenTag;
        closeTag = nextCloseTag;
      } else {
        c = template.substr(i, 1);

        switch (c) {
        case '"':
        case "\\":
          nonSpace = true;
          code.push("\\" + c);
          break;
        case "\n":
          spaces.push(code.length);
          code.push("\\n");

          // Check for whitespace on the current line.
          stripSpace();

          line++;
          break;
        default:
          if (isWhitespace(c)) {
            spaces.push(code.length);
          } else {
            nonSpace = true;
          }

          code.push(c);
        }
      }
    }

    // Clean up any whitespace from a closing {{tag}} that was at the end
    // of the template without a trailing \n.
    stripSpace();

    if (sectionStack.length != 0) {
      throw debug(new Error('Section "' + sectionStack[sectionStack.length - 1].name + '" was not closed properly'), template, line, options.file);
    }

    code.push('");');
    code.push("\nsend(null);"); // Send null as the last operation.
    code.push("\n} catch (e) { throw {error: e, line: line}; }");

    var body = code.join("");

    // Ignore empty send("") statements.
    body = body.replace(/send\(""\);\n/g, "");

    // TODO: Make safe for environments that don't support console.log.
    if (options.debug) {
      console.log(body);
    }

    return body;
  }

  /**
   * Used by `compile` to generate a reusable function for the given `template`.
   */
  function _compile(template, options) {
    var args = "view,partials,send,stack,find,escapeHTML,sendSection,render";
    var body = parse(template, options);
    var fn = new Function(args, body);

    /**
     * This anonymous function wraps the generated function so we can do
     * argument coercion, setup some variables, and handle any errors
     * encountered while executing it.
     */
    return function (view, partials, callback) {
      if (typeof partials == "function") {
        callback = partials;
        partials = {};
      }

      partials = partials || {};

      var buffer = []; // output buffer

      var send;
      if (typeof callback == "function") {
        send = callback;
      } else {
        send = function (chunk) {
          buffer.push(chunk);
        };
      }

      var stack = [view]; // context stack

      var find = function (name) {
        return findName(name, stack);
      };

      try {
        fn(view, partials, send, stack, find, escapeHTML, sendSection, render);
      } catch (e) {
        throw debug(e.error, template, e.line, options.file);
      }

      if (!callback) {
        return buffer.join("");
      }
    };
  }

  // Cache of pre-compiled templates.
  var _cache = {};

  /**
   * Clear the cache of compiled templates.
   */
  function clearCache() {
    _cache = {};
  }

  /**
   * Compiles the given `template` into a reusable function using the given
   * `options`. In addition to the options accepted by Mustache.parse,
   * recognized options include the following:
   *
   *   - cache    Set `false` to bypass any pre-compiled version of the given
   *              template. Otherwise, a given `template` string will be cached
   *              the first time it is parsed
   */
  function compile(template, options) {
    options = options || {};

    // Use a pre-compiled version from the cache if we have one.
    if (options.cache !== false) {
      if (!_cache[template]) {
        _cache[template] = _compile(template, options);
      }

      return _cache[template];
    }

    return _compile(template, options);
  }

  /**
   * High-level function that renders the given `template` using the given
   * `view`, `partials`, and `callback`. The `callback` is used to return the
   * output piece by piece, as it is rendered. When done, the callback will
   * receive `null` as its argument, after which it will not be called any more.
   * If no callback is given, the complete rendered template will be used as the
   * return value for the function.
   *
   * Note: If no partials are needed, the third argument may be the callback.
   * If you need to use any of the template options, you should compile in a
   * separate step, and then execute that compiled function.
   */
  function render(template, view, partials, callback) {
    if (typeof partials == "function") {
      callback = partials;
      partials = null;
    }

    return compile(template)(view, partials, callback);
  }

})(Mustache);
