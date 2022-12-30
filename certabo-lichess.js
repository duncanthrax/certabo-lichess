#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Edit these if required --------------------------------
const configDir = `${process.env.HOME}/.certabo-lichess`;
const rfidIdFilterRx = new RegExp(/^1200/);
const moveDetectionDelaySeconds = 3;
// -------------------------------------------------------

const serialDevice = process.argv[2];
const lichessName = process.argv[3];
const lichessToken = process.argv[4];

if (!serialDevice || !lichessName || !lichessToken) {
    console.log("Usage: certabo-lichess.js <serialDevice> <lichessName> <lichessToken>");
    process.exit(-1);
}

console.log(`Serial: ${serialDevice}`);
console.log(`  User: ${lichessName}`);
console.log(` Token: ${lichessToken}`);

const compareArray = (a1, a2) => {
    return (a1.length == a2.length && a1.every((u, i) => { return u === a2[i] })) ? true : false;
};

// FENBoard code inlined from https://github.com/laat/fen-chess-board
// Copyright (c) 2016 Sigurd Fosseng
// Licensed under MIT License

const ranks = { 1: 7, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 0 };
const files = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7 };

const getFileRank = (square) => {
    const [file, rank] = square;
    return [files[file], ranks[rank]];
};

const emptyBoard = () => {
    const board = [];
    for (let i = 0; i < 8; i++) {
        board[i] = [];
    }
    return board;
};

class FENBoard {
    constructor(fen) {
        this.board = emptyBoard();
        this.fen = fen;
    }

    piece(square) {
        const [file, rank] = getFileRank(square);
        return this._getPiece(file, rank);
    }

    put(square, piece) {
        const [file, rank] = getFileRank(square);
        this._setPiece(file, rank, piece);
    }

    clear(square) {
        this.put(square, '');
    }

    move(from, to) {
        const piece = this.piece(from);
        if (!piece) {
        throw new Error('Move Error: the from square was empty');
        }
        this.put(to, piece);
        this.clear(from);
    }

    set fen(fen) {
        // reset board
        this.board.forEach((r) => { r.length = 0; });

        if (!fen) return;
        if (fen === 'start') fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

        let rank = 0;
        let file = 0;
        let fenIndex = 0;

        let fenChar;
        let count;

        while (fenIndex < fen.length) {
        fenChar = fen[fenIndex];

        if (fenChar === ' ') {
            break; // ignore the rest
        }
        if (fenChar === '/') {
            rank++;
            file = 0;
            fenIndex++;
            continue;
        }

        if (isNaN(parseInt(fenChar, 10))) {
            this._setPiece(file, rank, fenChar);
            file++;
        } else {
            count = parseInt(fenChar, 10);
            for (let i = 0; i < count; i++) {
            this._setPiece(file, rank, '');
            file++;
            }
        }

        fenIndex++;
        }
    }

    get fen() {
        const fen = [];
        for (let i = 0; i < 8; i++) {
        let empty = 0;
        for (let j = 0; j < 8; j++) {
            const piece = this._getPiece(j, i);
            if (piece) {
            if (empty > 0) {
                fen.push(empty);
                empty = 0;
            }
            fen.push(piece);
            } else {
            empty++;
            }
        }
        if (empty > 0) {
            fen.push(empty);
        }
        fen.push('/');
        }
        fen.pop();
        return fen.join('');
    }

    _setPiece(file, rank, fenChar) {
        this.board[rank][file] = fenChar;
    }

    _getPiece(file, rank) {
        return this.board[rank][file];
    }
}
// End FENBoard code


// Singleton wrapper for Lichess
const Lch = {
    // Main state
    active: false,

    // The game structure as received from Lichess
    game: false,

    // If we have correct gamestate, and game is ongoing
    // 'none', 'running' or 'ended'
    gameState: 'none',

    playingMove: false,
    myLastMove: false,
    resigning: false,

    // Stream request used to follow the game
    streamReq: false,

    // Map of Lichess gameStates to our gamestate
    gameStatesMap: {
        "created": 'running',
        "started": 'running',
        "aborted": 'ended',
        "mate": 'ended',
        "resign": 'ended',
        "stalemate": 'ended',
        "timeout": 'ended',
        "draw": 'ended',
        "outoftime": 'ended',
        "cheat": 'ended',
        "noStart": 'ended',
        "unknownFinish": 'ended',
        "variantEnd": 'ended'
    },

    request: (options, cb) => {
        if (!options.headers) options.headers = {};

        options.method = options.method ? options.method : 'GET';
        options.host = 'lichess.org';
        options.path = `${options.path}`;
        options.headers['Authorization'] = `Bearer ${lichessToken}`;

        if (options.method.match(/(POST|PUT)/)) {
            options.headers['Content-Type'] = 'application/json';
        }

        console.log(`>>> ${options.method} ${options.path}`, options.body ? options.body : '');

        const req = https.request(options, (res) => {
            var data = [];
            res.on('data', function(chunk) { data.push(chunk) }).on('end', function() {
                var buffer = Buffer.concat(data);
                var json = false;
                console.log(`<<< ${res.statusCode} ${res.headers['content-type']}`);
                if (res.headers['content-type'].match(/application\/json/)) {
                    json = JSON.parse(buffer);
                    console.log('JSON', json);
                }
                else {
                    console.log("Error body", buffer.toString());
                }
                cb(res.statusCode.toString().match(/^2/) ? false : true, json ? json : "Unknown content");
            });
        });

        req.on('error', (e) => {
            cb(true, e);
        });

        req.end(options.body ? options.body : undefined);

        return req;
    },

    streamLines: (options, cb) => {
        if (!options.headers) options.headers = {};

        options.method = 'GET';
        options.host = 'lichess.org';
        options.path = `${options.path}`;
        options.headers['Authorization'] = `Bearer ${lichessToken}`;

        console.log(`--- ${options.method} ${options.path}`, options.body ? options.body : '');

        const req = https.request(options, (res) => {

            var data = '';
            var getNjson = chunk => {
                data += chunk;
                data = data.replace(/^(.*?)\n(.*)$/sg, (match, line, rest) => {
                    var obj = false;
                    if (line.length > 2) {
                        try { obj = JSON.parse(line) } catch(e) {
                            console.log("Unable to parse NJSON line", line, e);
                        }
                        if (obj) {
                            cb(false, obj);
                        }
                    }
                    return rest;
                });
            };
            res.on('data', chunk => { getNjson(chunk) });
            res.on('end',  chunk => { getNjson(chunk); cb(true, "End of stream") });
        });

        req.on('error', (e) => {
            cb(true, e);
        });

        req.end();

        return req;
    },

    teardown: () => {
        if (Lch.streamReq) { Lch.streamReq.destroy(); Lch.streamReq = false; };
        Lch.game = false;
        Lch.active = false;
        Lch.gameState = 'none';
        Lch.playingMove = false;
        Lch.resigning = false;
        Lch.myLastMove = false;
    },

    resign: () => {
        if (Lch.game && !Lch.resigning) {
            Lch.resigning = true;
            console.log("lichess: resigning game");
            Lch.request({ path: `/api/board/game/${Lch.game.gameId}/resign`, method: 'POST' }, (err, res) => {
                if (err) {
                    console.log("lichess: error resigning");
                }
                Lch.resigning = false;
            });
        }
    },

    playMove: (move) => {
        if (Lch.game && !Lch.playingMove && Lch.myLastMove != move) {
            Lch.playingMove = true;
            console.log("lichess: playing move", move);
            Lch.request({ path: `/api/board/game/${Lch.game.gameId}/move/${move}`, method: 'POST' }, (err, res) => {
                Lch.playingMove = false;
                if (err) {
                    console.log("lichess: error playing move", move);
                }
                else {
                    Lch.myLastMove = move;
                }
            });
        }
    },

    run: () => {
        // We get periodically called from the Board. Make sure we only run once.
        if (Lch.active) return;
        Lch.active = true;

        Lch.request({ path: '/api/account/playing' }, (err, res) => {
            if (err) {
                console.log("lichess: error getting active games");
                Lch.teardown();
            }
            else {
                if (res.nowPlaying && res.nowPlaying.length > 0) {
                    Lch.game = res.nowPlaying[0];
                    console.log("lichess: now entering game", Lch.game);

                    var startFEN = false;
                    Lch.streamReq = Lch.streamLines({ path: `/api/board/game/stream/${Lch.game.gameId}` }, (err, res) => {
                        if (err) {
                            if (Lch.gameState != 'ended') {
                                console.log("lichess: error while streaming game");
                                Lch.teardown();
                            }
                        }
                        else {
                            Board.moveDetection = false; // Disable move detection until board setup is correct

                            const updateBoard = (state) => {
                                if (!startFEN) return;
                                const board = new FENBoard(startFEN);
                                const moves = state.moves.split(/\s+/);
                                Lch.opponentsTurn = state.moves ?
                                    ((Lch.game.color == 'white') ? ((moves.length % 2) ? true : false) : ((moves.length % 2) ? false : true))
                                    :
                                    (Lch.game.color == 'black');
                                moves.forEach(move => {
                                    if (!move) return;
                                    const s = move.match(/^(..)(..)(.)?$/);
                                    if (s) {
                                        const from = s[1];
                                        const to = s[2];
                                        var promo = s[3] ? s[3] : false;

                                        // Castling
                                        if (board.board[0][4] == 'k') {
                                            if (from == 'e8' && to == 'g8') {
                                                // Black short rochade
                                                board.move('h8','f8');
                                            }
                                            if (from == 'e8' && to == 'c8') {
                                                // Black long rochade
                                                board.move('a8','d8');
                                            }
                                        }
                                        if (board.board[7][4] == 'K') {
                                            if (from == 'e1' && to == 'g1') {
                                                // White short rochade
                                                board.move('h1','f1');
                                            }
                                            if (from == 'e1' && to == 'c1') {
                                                // White long rochade
                                                board.move('a1','d1');
                                            }
                                        }

                                        // En passant
                                        if (
                                            board.piece(from).match(/p/i)
                                            && !board.piece(to)
                                            && from[0] != to[0]
                                           ) {
                                            // Remove pawn in 'to' column at 'from' row
                                            board.clear(`${to[0]}${from[1]}`);
                                        }

                                        board.move(from, to);
                                        if (promo) {
                                            if (board.piece(to) == board.piece(to).toUpperCase()) {
                                                // White promo
                                                promo = promo.toUpperCase();
                                            }
                                            board.put(to, promo);
                                        }

                                    }
                                    else {
                                        console.log("lichess: unable to parse move", move);
                                    }
                                });
                                Board.setBoard('game', board.fen);
                            };

                            if (res.type == 'gameFull') {
                                console.log("lichess: got gameFull", res);
                                startFEN = res.initialFen == 'startpos' ? 'start' : res.initialFen;
                                updateBoard(res.state);
                                Lch.gameState = Lch.gameStatesMap[res.state.status];
                            }

                            if (res.type == 'gameState') {
                                console.log("lichess: got gameState", res);
                                updateBoard(res);
                                Lch.gameState = Lch.gameStatesMap[res.status];
                            }

                            if (Lch.gameState == 'ended') {
                                console.log("lichess: game ended");
                            }

                        }
                    });

                }
                else {
                    // No game running, reset and try again next time.
                    Lch.teardown();
                }
            }
        });

    }
};

// Singleton wrapper for the Certabo board
const Board = {
    // Main state
    online: false,
    mode: false,
    moveDetection: false,

    // Map of RFID IDs to pieces
    pieces: {},

    // RFID IDs, keyed by field name
    rfidIds: {},

    // Desired LED state, keyed by field name
    leds: {},
    ledInterval: false,

    state: {
        real: new FENBoard(),
        game: new FENBoard(),
        start: new FENBoard('start')
    },

    offFields: [],

    stagedMove: false,
    stagedMoveSince: 0,

    serialPort: false,

    // Cycle counter, loops back to 1 at 9999
    cycle: 1,

    // Returns array with all field names from top left to bottom right
    allFields: () => {
        const fields = [];
        ['8','7','6','5','4','3','2','1'].forEach(rank => {
            ['a','b','c','d','e','f','g','h'].forEach(file => {
                fields.push(file + rank);
            });
        });
        return fields;
    },

    clearBoard: (boardId) => {
        return Board.state[boardId].fen = false;
    },
    setBoard: (boardId, fen) => {
        return Board.state[boardId].fen = fen;
    },
    getPiece: (boardId, field) => {
        return Board.state[boardId].piece(field);
    },
    putPiece: (boardId, field, piece) => {
        return Board.state[boardId].put(field, piece);
    },
    clearField: (boardId, field) => {
        return Board.state[boardId].clear(field);
    },
    movePiece: (boardId, from, to) => {
        return Board.state[boardId].move(from, to);
    },
    getPieceColor: (piece) => {
        if (!piece) return false;
        return piece.match(/[a-z]{1}/) ? 'black' : 'white';
    },
    findPiece: (boardId, piece) => {
        return Board.allFields().filter(field => { return Board.getPiece(boardId, field) == piece });
    },
    hasRfidPiece: (field) => {
        var fields = field.match(/.{2}/g);
        return fields.find(f => { return Board.rfidIds[f] ? false : true }) ? false : true;
    },
    getFileRankIdx: (field) => {
        const s = field.split('');
        return [files[s[0]],ranks[s[1]]];
    },
    loadPieces: () => {
        try { Board.pieces = JSON.parse(fs.readFileSync(`${configDir}/pieces.json`)) } catch(e){};
    },
    serialTeardown: () => {
        if (Board.online) {
            console.log("Board has gone offline");
            Board.online = false;
        }
        setTimeout(Board.run, 1000);
    },
    initState: () => {
        Board.moveDetection = false;
        Board.clearBoard('game');
        Board.clearBoard('real');
        Board.offFields = [];
    },

    run: () => {

        Board.online = false;
        Board.mode = false;

        Lch.teardown();

        Board.initState();

        Board.serialPort = new SerialPort({ path: serialDevice, baudRate: 38400 });
        Board.serialPort.on('close', Board.serialTeardown);
        Board.serialPort.on('error', Board.serialTeardown);

        Board.loadPieces(); // Best effort

        // Reading - the board sends RFID status automatically in lines
        // starting with ':' and ending with '\n'. In between are 320 (64 * 5)
        // decimal numbers as strings. Each pack of five numbers is an RFID
        // ID of a detected piece, or all zeroes. Erratic readings on empty
        // fields are common and need to be filtered by matching rfidIdFilterRx.
        Board.serialPort.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', (data) => {

            // Bump cycle counter
            Board.cycle++; if (Board.cycle > 9999) Board.cycle = 1;

            // Sanitize date
            if (!data.match(/^\:/)) return; // Not a full line
            data = data.replace(/^\:/,'').replace(/\s+$/,'').replace(/^\s+/,'');
            if (data.match(/[^0-9 ]/)) return; // Only numbers and whitespace allowed
            const numbers = data.split(/ +/);
            if (numbers.length != 320) return; // Not a full line

            // Update RFID IDs and real Board state
            Board.allFields().forEach(field => {
                Board.clearField('real', field);
                let rfidId = ''; while (rfidId.length < 10) rfidId += parseInt(numbers.shift()).toString(16).padStart(2,'0');
                if (!rfidId.match(rfidIdFilterRx)) return;
                Board.rfidIds[field] = rfidId == '0000000000' ? false : rfidId.toUpperCase();
                if (Board.pieces[Board.rfidIds[field]]) Board.putPiece('real', field, Board.pieces[Board.rfidIds[field]])
            });

            if (Board.mode == 'detect' && Board.hasRfidPiece('a1b1c1d1e1f1g1h1a2b2c2d2e2f2g2h2a7b7c7d7e7f7g7h7a8b8c8d8e8f8g8h8')) {
                Board.allFields().forEach(field => {
                    if (!Board.hasRfidPiece(field)) return;
                    const basePiece = Board.getPiece('start', field);
                    if (basePiece) {
                        Board.pieces[Board.rfidIds[field]] = basePiece;
                    }
                    else {
                        // All other present pieces are spare Queens.
                        // White when in rows 3+4, Black in rows 5+6.
                        if (field.match(/(3|4)$/)) {
                            Board.pieces[Board.rfidIds[field]] = 'Q';
                            console.log(`Spare white queen on ${field}`);
                        }
                        if (field.match(/(5|6)$/)) {
                            Board.pieces[Board.rfidIds[field]] = 'q';
                            console.log(`Spare black queen on ${field}`);
                        }
                    }
                });
                console.log("RFID pieces after detection", Board.pieces);

                try { fs.mkdirSync(`${configDir}`) } catch(e){};
                try {
                    fs.writeFileSync(`${configDir}/pieces.json`, JSON.stringify(Board.pieces));
                }
                catch(e) {
                    console.log("Error writing", `${configDir}/pieces.json`, e);
                }
                Board.mode = false;
            }

            if (!Board.online) {
                // If we've made it here, board is online.
                console.log("Board has come online");
                Board.online = true;

                // If a1 is populated as the only field, start detect mode
                if (Board.hasRfidPiece('a1') && Board.allFields().reduce((n, x) => n + (Board.rfidIds[x] ? 1:0), 0) == 1) {
                    console.log("Single piece on a1, entering detection mode");
                    Board.mode = 'detect';
                }

                // If we don't have at least 4*8 pieces, start detect mode
                if (Object.keys(Board.pieces).length < 4*8) {
                    console.log("Don't have enough pieces, entering detection mode");
                    Board.mode = 'detect';
                }
            }

            // Board is online past this point -------------------------------------------------
            if (!Board.online) return;

            if (!Board.mode) {
                // Clear LEDs
                Board.leds = {};

                // Compute field mismatches between real and game boards
                const offFields = Board.allFields().filter(field => (Board.getPiece('real', field) != Board.getPiece('game', field)));

                if (!compareArray(offFields, Board.offFields)) {
                    Board.offFields = offFields;
                    console.log("Off Fields", Board.offFields);
                }

                if (Lch.gameState.match(/(running|ended)/)) {
                    // Highlight off fields
                    Board.offFields.forEach(field => { Board.leds[field] = 1 });

                    // Unlock move detection when there are no off fields
                    if (Board.offFields.length == 0) Board.moveDetection = true;

                    if (Lch.gameState == 'running') {

                        // Move detection
                        if (Board.moveDetection) {

                            var newStagedMove = false;

                            // Rochade detection
                            if (Lch.game.color == 'white') {
                                if (compareArray(['e1','f1','g1','h1'], Board.offFields)) {
                                    if (!Board.getPiece('real', 'e1') &&
                                        !Board.getPiece('real', 'h1') &&
                                        Board.getPiece('real', 'g1') == 'K' &&
                                        Board.getPiece('real', 'f1') == 'R') {
                                        console.log("White short castling");
                                        newStagedMove = 'e1h1';
                                    }
                                }
                                if (compareArray(['a1','c1','d1','e1'], Board.offFields)) {
                                    if (!Board.getPiece('real', 'a1') &&
                                        !Board.getPiece('real', 'e1') &&
                                        Board.getPiece('real', 'c1') == 'K' &&
                                        Board.getPiece('real', 'd1') == 'R') {
                                        console.log("White long castling");
                                        newStagedMove = 'e1a1';
                                    }
                                }
                            }
                            else {
                                if (compareArray(['e8','f8','g8','h8'], Board.offFields)) {
                                    if (!Board.getPiece('real', 'e8') &&
                                        !Board.getPiece('real', 'h8') &&
                                        Board.getPiece('real', 'g8') == 'k' &&
                                        Board.getPiece('real', 'f8') == 'r') {
                                        console.log("Black short castling");
                                        newStagedMove = 'e8h8';
                                    }
                                }
                                if (compareArray(['a8','c8','d8','e8'], Board.offFields)) {
                                    if (!Board.getPiece('real', 'a8') &&
                                        !Board.getPiece('real', 'e8') &&
                                        Board.getPiece('real', 'c8') == 'k' &&
                                        Board.getPiece('real', 'd8') == 'r') {
                                        console.log("Black long castling");
                                        newStagedMove = 'e8a8';
                                    }
                                }
                            }

                            // Special case for en passant when taken piece was already taken off board.
                            // En passant with taken piece still on board is detected below.
                            if (Board.offFields.length == 3) {
                                // Two fields on same rank are empty, the other has a pawn with file off by one.
                                const emptyFields = [];
                                var pawnField  = false;
                                Board.offFields.forEach(field => {
                                    const p = Board.getPiece('real', field);
                                    if (p) {
                                        if (p.match(/p/i)) pawnField = field;
                                    }
                                    else { emptyFields.push(field) };
                                });

                                if (
                                    emptyFields.length == 2
                                    && pawnField
                                    && emptyFields[0][1] == emptyFields[1][1]
                                    && Math.abs(parseInt(pawnField[1]) - parseInt(emptyFields[0][1])) == 1
                                ) {
                                    const fieldFrom = (emptyFields[0][0] == pawnField[0]) ? emptyFields[1] : emptyFields[0];
                                    newStagedMove = `${fieldFrom}${pawnField}`;
                                }
                            }

                            // Moves with 2 off fields
                            if (Board.offFields.length == 2) {
                                // Swap kings == give up game
                                const wrk = Board.findPiece('real','K');
                                const brk = Board.findPiece('real','k');
                                const wgk = Board.findPiece('game','K');
                                const bgk = Board.findPiece('game','k');
                                if (wrk[0] == bgk[0] && brk[0] == wgk[0]) {
                                    console.log("Swapped Kings - giving up game");
                                    Lch.resign();
                                };

                                // One field must be empty, the other must have a piece in our color
                                // This also works for en passant if the captured piece stays on the board until the move has executed.
                                const f0 = Board.getPiece('real', Board.offFields[0]);
                                const f1 = Board.getPiece('real', Board.offFields[1]);
                                const from = f0 ? (f1 ? false : f1) : (f1 ? f0 : false);
                                if (from !== false) {
                                    const to = from === f0 ? f1 : f0;
                                    if (Board.getPieceColor(to) == Lch.game.color) {
                                        const fieldFrom = (from === f0) ? Board.offFields[0] : Board.offFields[1];
                                        const   fieldTo = (from === f0) ? Board.offFields[1] : Board.offFields[0];

                                        // Promotion detection. If pawn is moved to rank 1 or 8, require non-pawn on target field.
                                        if (Board.getPiece('game', fieldFrom).match(/p/i) && fieldTo.match(/[18]$/)) {
                                            if (to.match(/[rbnq]/i)) {
                                                newStagedMove = `${fieldFrom}${fieldTo}${to.toLowerCase()}`;
                                            }
                                        }
                                        else {
                                            // Normal move detected, play it.
                                            newStagedMove = `${fieldFrom}${fieldTo}`;
                                        }
                                    }
                                }
                            }

                            if (newStagedMove) {
                                if (Board.stagedMove == newStagedMove) {
                                    // Same move, check how old it is
                                    if (((Date.now() - Board.stagedMoveSince) / 1000) > moveDetectionDelaySeconds) Lch.playMove(Board.stagedMove);
                                }
                                else {
                                    // Different move, stage it
                                    Board.stagedMove = newStagedMove;
                                    Board.stagedMoveSince = Date.now();
                                }
                            }
                            else {
                                // No move detected, unstage previously staged move
                                Board.stagedMove = false;
                                Board.stagedMoveSince = 0;
                            }
                        }

                        // If we're waiting for opponent, blink far row
                        if (Lch.opponentsTurn) {
                            Board.allFields().forEach(field => {
                                if (Lch.game.color == 'white') {
                                    if (!Board.leds[field] && field.match(/[8]$/)) Board.leds[field] = 2;
                                }
                                else {
                                    if (!Board.leds[field] && field.match(/[1]$/)) Board.leds[field] = 2;
                                }
                            });
                        }

                        // If we still have staged move, blink off fields ("the move")
                        if (Board.stagedMove) {
                            Board.offFields.forEach((field,idx) => {
                                Board.leds[field] = parseInt((idx + (Board.ledInterval ? 1 : 0)) % 2);
                            });
                        }
                    }

                    if (Lch.gameState == 'ended') {
                        // When game has ended, reset state when not both kings are on the board.
                        if (Board.findPiece('real','K').length == 0 || Board.findPiece('real','k').length == 0) {
                            Lch.teardown();
                            Board.initState();
                        }

                        // When no off fields to display, signal end state
                        if (Board.offFields.length == 0) {
                            Board.allFields().forEach(field => {
                                Board.leds[field] = (field.match(/^[ah]/) || field.match(/[18]$/)) ? 1 : 0;
                            });
                        }
                    }
                }
                else {
                    // No game running. Alternate blink diagonally.
                    Board.allFields().forEach((field,idx) => {
                        const alternate = parseInt(parseInt(idx / 8) % 2);
                        Board.leds[field] = parseInt((idx + alternate + (Board.ledInterval ? 1 : 0)) % 2);
                    });
                }
            }
            else {
                // Board in special mode (right now, detection only)
                if (Board.mode == 'detect') {
                    Board.allFields().forEach(field => {
                        Board.leds[field] = field.match(/[1278]$/) ? 1 : 0;
                    });
                }
            }

            // Writing - We only need to update LED status.
            // LED addressing, one bit per LED. 0 = off, 1 = on.
            // 64 LEDs in 8 bytes, one byte per row. Order top row to bottom row.
            // LSB = leftmost LED, MSB = rightmost LED
            let ledState = new Array(8).fill(0);
            Board.allFields().forEach(field => {
                const [fileIdx, rankIdx] = Board.getFileRankIdx(field);
                const onoff = Board.leds[field] == 1 ? 1 : (Board.leds[field] == 2 ? (Board.ledInterval ? 1 : 0) : 0 );
                ledState[rankIdx] |= onoff * (2 ** fileIdx);
            });
            Board.serialPort.write(Buffer.from(ledState));

            Board.ledInterval = Board.ledInterval ? false : true;

            // Kick off Lichess
            if (!Board.mode) Lch.run();

        });
    }
};

Board.run();
