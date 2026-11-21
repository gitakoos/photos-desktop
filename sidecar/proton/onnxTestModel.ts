/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// A made-up ONNX model for the tests, written out byte by byte: `layers` matrix products of
// `width` square, each followed by a ReLU, with fixed pseudo-random weights. Large settings make
// a model the runtime takes a while to open and to run, with no model file to download.

/** A protobuf varint. */
function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

const num = (field: number, n: number) => Buffer.concat([varint(field << 3), varint(n)]);
const len = (field: number, payload: Buffer) => Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
const text = (field: number, s: string) => len(field, Buffer.from(s, "utf8"));

const FLOAT = 1;

function valueInfo(name: string, dims: number[]): Buffer {
  const shape = Buffer.concat(dims.map((d) => len(1, num(1, d))));
  const tensorType = Buffer.concat([num(1, FLOAT), len(2, shape)]);
  return Buffer.concat([text(1, name), len(2, len(1, tensorType))]);
}

function initializer(name: string, dims: number[], values: Float32Array): Buffer {
  return Buffer.concat([
    ...dims.map((d) => num(1, d)),
    num(2, FLOAT),
    text(8, name),
    len(9, Buffer.from(values.buffer, values.byteOffset, values.byteLength)),
  ]);
}

function node(op: string, inputs: string[], output: string, name: string): Buffer {
  return Buffer.concat([...inputs.map((i) => text(1, i)), text(2, output), text(3, name), text(4, op)]);
}

/** The model's bytes: input `x` of [1, width], output `y` of the same shape. */
export function testModel(width: number, layers: number, seed = 1): Buffer {
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
  const nodes: Buffer[] = [];
  const weights: Buffer[] = [];
  let last = "x";
  for (let l = 0; l < layers; l++) {
    const w = new Float32Array(width * width);
    for (let i = 0; i < w.length; i++) w[i] = random() * Math.sqrt(24 / width);
    weights.push(len(5, initializer(`w${l}`, [width, width], w)));
    nodes.push(len(1, node("MatMul", [last, `w${l}`], `m${l}`, `matmul${l}`)));
    const out = l === layers - 1 ? "y" : `r${l}`;
    nodes.push(len(1, node("Relu", [`m${l}`], out, `relu${l}`)));
    last = out;
  }
  const graph = Buffer.concat([
    ...nodes,
    text(2, "test"),
    ...weights,
    len(11, valueInfo("x", [1, width])),
    len(12, valueInfo("y", [1, width])),
  ]);
  return Buffer.concat([num(1, 8), text(2, "pfp-test"), len(7, graph), len(8, Buffer.concat([text(1, ""), num(2, 13)]))]);
}
