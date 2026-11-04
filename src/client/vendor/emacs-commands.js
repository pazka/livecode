// deno-lint-ignore-file
// @ts-nocheck
// Restores the Emacs keymap of @replit/codemirror-emacs 6.1.0 (MIT, (C) 2018-2021 Marijn Haverbeke and
// others; source: https://unpkg.com/@replit/codemirror-emacs@6.1.0/dist/index.js, lines 651-998, verbatim).
//
// Why (owner bug X.18): the package registers its key table and its commands in statements annotated as
// side-effect free ("pure"): the bindKey loop and the addCommands call. A minifying bundler may drop pure
// calls whose result is unused, and `deno bundle --minify` does, so the shipped Emacs mode had no keys and
// no commands at all. This module re-runs both, unannotated, against the package's own exported
// EmacsHandler / emacsKeys. Same code, same version; drop this file once the package is fixed.

import { EditorSelection } from "@codemirror/state";
import * as commands from "@codemirror/commands";
import { EmacsHandler, emacsKeys } from "@replit/codemirror-emacs";

EmacsHandler.addCommands({
    unsetTransientMark: function (handler) {
        handler.setEmacsMark(null);
        return false;
    },
    markWord: function (handler, args) {
    },
    selectParagraph: function (handler, args) {
        var view = handler.view;
        var head = view.state.selection.ranges[0].head;
        var doc = view.state.doc;
        var startLine = doc.lineAt(head);
        var start = -1;
        var end = -1;
        var line = startLine;
        while (/\S/.test(line.text) && line.from > 0) {
            start = line.from;
            line = view.state.doc.lineAt(line.from - 1);
        }
        if (start == -1) {
            while (!/\S/.test(line.text) && line.to < doc.length) {
                start = line.from;
                line = view.state.doc.lineAt(line.to + 1);
            }
        }
        else {
            line = startLine;
        }
        while (/\S/.test(line.text) && line.to < doc.length) {
            end = line.to;
            line = view.state.doc.lineAt(line.to + 1);
        }
        if (end == -1) {
            end = startLine.to;
        }
        var newRanges = [EditorSelection.range(start, end)];
        view.dispatch({
            selection: EditorSelection.create(newRanges)
        });
    },
    goOrSelect: {
        exec: function (handler, args) {
            var command = handler.emacsMark() ? args[1] : args[0];
            command(handler.view);
        }
    },
    changeCase: function (handler, args) {
        var view = handler.view;
        if (!args.region) {
            handler.clearSelection();
            commands.selectGroupForward(view);
        }
        var specs = view.state.changeByRange((range) => {
            var toInsert = view.state.sliceDoc(range.from, range.to);
            toInsert = args.dir == 1 ? toInsert.toUpperCase() : toInsert.toLowerCase();
            return {
                changes: { from: range.from, to: range.to, insert: toInsert },
                range: EditorSelection.cursor(range.from + toInsert.length)
            };
        });
        view.dispatch(specs);
    },
    centerSelection: function (handler) {
        handler.view.dispatch({ scrollIntoView: true });
    },
    recenterTopBottom: function (handler) {
        var view = handler.view;
        var scrollTop = view.scrollDOM.scrollTop;
        view.dispatch({ scrollIntoView: true });
        try {
            // force synchronous measurment
            view.measure(true);
        }
        catch (e) { }
        if (scrollTop != view.scrollDOM.scrollTop)
            return;
        var base = view.scrollDOM.getBoundingClientRect();
        var cursor = view.coordsAtPos(view.state.selection.main.head);
        if (!cursor)
            return;
        var lineHeight = cursor.bottom - cursor.top;
        var screenHeight = base.height;
        var cursorTop = cursor.top - base.top;
        if (Math.abs(cursorTop) < lineHeight / 4) {
            scrollTop += cursorTop + lineHeight - screenHeight + 2;
        }
        else if (Math.abs(cursorTop - screenHeight * 0.5) < lineHeight / 4) {
            scrollTop += cursorTop - 2;
        }
        else {
            scrollTop += cursorTop - screenHeight * 0.5;
        }
        view.scrollDOM.scrollTop = scrollTop;
    },
    selectRectangularRegion: function (handler) {
        var view = handler.view;
        var ranges = view.state.selection.ranges;
        var newRanges = [];
        if (ranges.length > 1) {
            newRanges.push(EditorSelection.range(ranges[0].from, ranges[ranges.length - 1].to));
        }
        else {
            let doc = view.state.doc;
            let startLine = doc.lineAt(ranges[0].from);
            let endLine = doc.lineAt(ranges[0].to);
            let startCollumn = ranges[0].from - startLine.from;
            let endCollumn = ranges[0].to - endLine.from;
            while (startLine.from < endLine.to) {
                newRanges.push(EditorSelection.range(startLine.from + startCollumn, startLine.from + endCollumn));
                if (startLine.to + 1 >= doc.length)
                    break;
                startLine = doc.lineAt(startLine.to + 1);
            }
        }
        view.dispatch({
            selection: EditorSelection.create(newRanges)
        });
    },
    setMark: {
        exec: function (handler, args) {
            var view = handler.view;
            var ranges = view.state.selection.ranges;
            // Sets mark-mode and clears current selection.
            // When mark is set, keyboard cursor movement commands become
            // selection modification commands. That is,
            // "goto" commands become "select" commands.
            // Any insertion or mouse click resets mark-mode.
            // setMark twice in a row at the same place resets markmode.
            // in multi select mode, ea selection is handled individually
            if (args && args.count) {
                var newMark = handler.selectionToEmacsMark();
                var mark = handler.popEmacsMark();
                if (mark) {
                    var newRanges = mark.map((p) => {
                        return EditorSelection.cursor(p, p);
                    });
                    view.dispatch({
                        selection: EditorSelection.create(newRanges)
                    });
                    handler.$emacsMarkRing.unshift(newMark);
                }
                return;
            }
            var mark = handler.emacsMark();
            var rangePositions = ranges.map(function (r) { return r.head; });
            var hasNoSelection = ranges.every(function (range) { return range.from == range.to; });
            // if transientMarkModeActive then mark behavior is a little
            // different. Deactivate the mark when setMark is run with active
            // mark
            if ((mark || !hasNoSelection)) {
                handler.clearSelection();
                if (mark)
                    handler.pushEmacsMark(null);
                return;
            }
            if (!mark) {
                handler.pushEmacsMark(rangePositions);
                handler.setEmacsMark(rangePositions);
                return;
            }
            // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
        },
        readOnly: true,
        handlesCount: true
    },
    exchangePointAndMark: {
        exec: function (handler, args) {
            var view = handler.view;
            var selection = view.state.selection;
            var isEmpty = !selection.ranges.some(r => r.from != r.to);
            if (!args.count && !isEmpty) { // just invert selection
                var newRanges = selection.ranges.map(x => {
                    return EditorSelection.range(x.head, x.anchor);
                });
                view.dispatch({
                    selection: EditorSelection.create(newRanges, selection.mainIndex)
                });
                return;
            }
            var markRing = handler.$emacsMarkRing;
            var lastMark = markRing[markRing.length - 1];
            if (!lastMark)
                return;
            if (args.count) { // replace mark and point
                markRing[markRing.length - 1] = handler.selectionToEmacsMark();
                handler.clearSelection();
                var newRanges = lastMark.map(x => {
                    return EditorSelection.range(x, x);
                });
                view.dispatch({
                    selection: EditorSelection.create(newRanges, selection.mainIndex)
                });
            }
            else { // create selection to last mark
                var n = Math.min(lastMark.length, selection.ranges.length);
                newRanges = [];
                for (var i = 0; i < n; i++) {
                    newRanges.push(EditorSelection.range(selection.ranges[i].head, lastMark[i]));
                }
            }
        },
        readOnly: true,
        handlesCount: true,
    },
    killWord: {
        exec: function (handler, dir) {
            var view = handler.view;
            var selection = view.state.selection;
            var newRanges = selection.ranges.map(x => {
                return EditorSelection.range(x.head, x.head);
            });
            view.dispatch({
                selection: EditorSelection.create(newRanges, selection.mainIndex)
            });
            if (dir == "left")
                commands.selectGroupBackward(view);
            else
                commands.selectGroupForward(view);
            selection = view.state.selection;
            selection.ranges.forEach(r => {
                var text = view.state.sliceDoc(r.from, r.to);
                killRing.add(text);
            });
            view.dispatch(view.state.replaceSelection(""));
        },
    },
    killLine: {
        exec: function (handler) {
            handler.pushEmacsMark(null);
            // don't delete the selection if it's before the cursor
            handler.clearSelection();
            var view = handler.view;
            var state = view.state;
            var text = [];
            var changes = state.selection.ranges.map(function (range) {
                var from = range.head;
                var lineObject = state.doc.lineAt(from);
                var to = lineObject.to;
                var line = state.sliceDoc(from, to);
                // remove EOL if only whitespace remains after the cursor
                if (/^\s*$/.test(line) && to < state.doc.length - 1) {
                    to += 1;
                    text.push(line + "\n");
                }
                else {
                    text.push(line);
                }
                return { from, to, insert: "" };
            });
            if (handler.$data.lastCommand == "killLine") {
                killRing.append(text.join("\n"));
            }
            else {
                killRing.add(text.join("\n"));
            }
            handler.$data.lastCommand = "killLine";
            view.dispatch({ changes });
        },
        keepLastCommand: true
    },
    yank: {
        exec: function (handler) {
            handler.onPaste(killRing.get());
            handler.$data.lastCommand = "yank";
        },
        keepLastCommand: true
    },
    yankRotate: {
        exec: function (handler) {
            if (handler.$data.lastCommand != "yank")
                return;
            commands.undo(handler.view);
            handler.$emacsMarkRing.pop(); // also undo recording mark
            handler.onPaste(killRing.rotate());
            handler.$data.lastCommand = "yank";
        },
        keepLastCommand: true
    },
    killRegion: {
        exec: function (handler) {
            killRing.add(handler.getCopyText());
            var view = handler.view;
            view.dispatch(view.state.replaceSelection(""));
            handler.setEmacsMark(null);
        },
    },
    killRingSave: {
        exec: function (handler) {
            var text = handler.getCopyText();
            killRing.add(text);
            handler.clearSelection();
            navigator.clipboard.writeText(text);
        },
        readOnly: true
    },
    keyboardQuit: function (handler) {
        var view = handler.view;
        var selection = view.state.selection;
        var isEmpty = !selection.ranges.some(r => r.from != r.to);
        if (selection.ranges.length > 1 && !isEmpty) {
            var newRanges = selection.ranges.map(x => {
                return EditorSelection.range(x.head, x.head);
            });
            view.dispatch({
                selection: EditorSelection.create(newRanges, selection.mainIndex)
            });
        }
        else {
            commands.simplifySelection(handler.view);
        }
        handler.setEmacsMark(null);
        handler.$data.count = null;
    },
    focusCommandLine: function (handler, arg) {
        handler.showCommandLine(arg);
    }
});
const killRing = {
    $data: [],
    add: function (str) {
        str && this.$data.push(str);
        if (this.$data.length > 30)
            this.$data.shift();
    },
    append: function (str) {
        var idx = this.$data.length - 1;
        var text = this.$data[idx] || "";
        if (str)
            text += str;
        if (text)
            this.$data[idx] = text;
    },
    get: function (n) {
        n = n || 1;
        return this.$data.slice(this.$data.length - n, this.$data.length).reverse().join('\n');
    },
    pop: function () {
        if (this.$data.length > 1)
            this.$data.pop();
        return this.get();
    },
    rotate: function () {
        let last = this.$data.pop();
        if (last)
            this.$data.unshift(last);
        return this.get();
    }
};

// the key table, registered for real
for (const k in emacsKeys) EmacsHandler.bindKey(k, emacsKeys[k]);
