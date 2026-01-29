# @vocdoni/davinci-circom

TypeScript/JavaScript library for generating zkSNARK circuit inputs for the DAVINCI voting protocol.

## Installation

```bash
npm install @vocdoni/davinci-circom
```

## Overview

This package provides utilities to:

- Generate circuit inputs for the DAVINCI ballot proof circuit
- Handle coordinate conversion between Gnark (RTE) and Circom (TE) BabyJubJub formats
- Encrypt ballot fields using ElGamal encryption
- Compute vote IDs and input hashes

## Quick Start

```typescript
import { BallotBuilder } from '@vocdoni/davinci-circom';

// Initialize the builder (loads Poseidon and BabyJubJub)
const builder = await BallotBuilder.build();

// Generate inputs from sequencer data
const inputs = builder.generateInputsFromSequencer(
    sequencerData,  // Data from DAVINCI sequencer API
    [1, 2],         // Vote field values
    1               // Voter weight
);

// Use inputs with snarkjs to generate a proof
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs,
    'ballot_proof.wasm',
    'ballot_proof.zkey'
);
```

## API Reference

### BallotBuilder

The main class for generating circuit inputs.

#### `BallotBuilder.build(): Promise<BallotBuilder>`

Creates a new BallotBuilder instance. This is async because it needs to initialize the Poseidon hash and BabyJubJub curve.

```typescript
const builder = await BallotBuilder.build();
```

#### `generateInputsFromSequencer(sequencerData, fields, weight, k?, circuitCapacity?): BallotInputs`

**Recommended method** for generating inputs from DAVINCI sequencer data. Handles all coordinate conversions automatically.

```typescript
import type { SequencerProcessData } from '@vocdoni/davinci-circom';

const sequencerData: SequencerProcessData = {
    processId: "a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000010",
    address: "0xA62E32147e9c1EA76DA552Be6E0636F1984143AF",
    pubKeyX: "19485953556403312941904393378091455968053684322142533232252221507246354347357",
    pubKeyY: "16219479350243308044593790248520319281271283090548119799482663113896815349782",
    ballotMode: {
        numFields: 2,
        uniqueValues: false,
        maxValue: "3",
        minValue: "0",
        maxValueSum: "6",
        minValueSum: "0",
        costExponent: 0,
        costFromWeight: false,
    }
};

const inputs = builder.generateInputsFromSequencer(
    sequencerData,
    [1, 2],     // fields: your vote values
    1,          // weight: voter weight
    undefined,  // k: optional, random if not provided
    8           // circuitCapacity: default 8
);
```

**Parameters:**
- `sequencerData` - Process data from the DAVINCI sequencer (pubKey in RTE format)
- `fields` - Array of vote field values
- `weight` - Voter's weight
- `k` - (Optional) Random scalar for encryption. Generated if not provided.
- `circuitCapacity` - (Optional) Number of fields the circuit supports. Default: 8

#### `generateInputs(fields, weight, pubKey, processId, address, k, config, circuitCapacity?): BallotInputs`

Lower-level method for generating inputs. Use this when you need more control.

**Important:** The `pubKey` parameter must be in TE (Twisted Edwards) format as field elements. Use `createPubKeyFromRTE()` or `createPubKeyFromTE()` to create it.

```typescript
// Create pubKey from RTE coordinates (from sequencer)
const pubKey = builder.createPubKeyFromRTE(pubKeyX, pubKeyY);

// Or from TE coordinates (if you already have them)
const pubKey = builder.createPubKeyFromTE(pubKeyX, pubKeyY);

const inputs = builder.generateInputs(
    [1, 2],                    // fields
    1,                         // weight
    pubKey,                    // public key (TE format)
    "123456789",               // processId (decimal string)
    "987654321",               // address (decimal string)
    builder.randomK(),         // k
    {
        numFields: 2,
        uniqueValues: 0,
        maxValue: 3,
        minValue: 0,
        maxValueSum: 6,
        minValueSum: 0,
        costExponent: 0,
        costFromWeight: 0,
    }
);
```

#### `createPubKeyFromRTE(x, y): FieldElement[]`

Creates a public key from RTE (Reduced Twisted Edwards) coordinates. Use this when you have coordinates from a Gnark-based system like the DAVINCI sequencer.

```typescript
const pubKey = builder.createPubKeyFromRTE(
    "19485953556403312941904393378091455968053684322142533232252221507246354347357",
    "16219479350243308044593790248520319281271283090548119799482663113896815349782"
);
```

#### `createPubKeyFromTE(x, y): FieldElement[]`

Creates a public key from TE (Twisted Edwards) coordinates. Use this when you already have coordinates in the standard circomlibjs format.

```typescript
const pubKey = builder.createPubKeyFromTE(
    "17969999239738372351885091931880390300351982063179132332592866336255785122524",
    "16219479350243308044593790248520319281271283090548119799482663113896815349782"
);
```

#### `randomK(): string`

Generates a random scalar suitable for ElGamal encryption.

```typescript
const k = builder.randomK();
```

#### `computeVoteID(processId, address, k): string`

Computes the vote ID from process ID, address, and k. The vote ID is a Poseidon hash truncated to 160 bits.

```typescript
const voteId = builder.computeVoteID(processId, address, k);
```

### Coordinate Conversion Functions

The DAVINCI sequencer uses Gnark's BabyJubJub implementation which uses **Reduced Twisted Edwards (RTE)** coordinates, while circomlibjs uses **Standard Twisted Edwards (TE)** coordinates. These functions handle the conversion.

#### `fromRTEtoTE(x, y): [bigint, bigint]`

Converts a point from RTE to TE coordinates.

```typescript
import { fromRTEtoTE } from '@vocdoni/davinci-circom';

const [xTE, yTE] = fromRTEtoTE(
    19485953556403312941904393378091455968053684322142533232252221507246354347357n,
    16219479350243308044593790248520319281271283090548119799482663113896815349782n
);
```

#### `fromTEtoRTE(x, y): [bigint, bigint]`

Converts a point from TE to RTE coordinates.

```typescript
import { fromTEtoRTE } from '@vocdoni/davinci-circom';

const [xRTE, yRTE] = fromTEtoRTE(xTE, yTE);
```

### Helper Functions

#### `hexToDecimal(hex): string`

Converts a hex string (with or without `0x` prefix) to a decimal string.

```typescript
import { hexToDecimal } from '@vocdoni/davinci-circom';

const processId = hexToDecimal("0xa62e32147e9c1ea76da552be6e0636f1984143af");
// "948722664824127043634469939323285494243801514927"
```

#### `parseBallotMode(ballotMode): BallotConfig`

Converts sequencer ballot mode format to circuit config format.

```typescript
import { parseBallotMode } from '@vocdoni/davinci-circom';

const config = parseBallotMode({
    numFields: 2,
    uniqueValues: false,  // boolean in sequencer format
    maxValue: "3",        // string in sequencer format
    // ...
});
// Returns { numFields: 2, uniqueValues: 0, maxValue: 3, ... }
```

### Types

#### `BallotInputs`

The circuit input format returned by `generateInputs` methods:

```typescript
interface BallotInputs {
    fields: number[];
    weight: number;
    encryption_pubkey: string[];
    cipherfields: string[][][];
    process_id: string;
    address: string;
    k: string;
    vote_id: string;
    inputs_hash: string;
    num_fields: number;
    unique_values: number;
    max_value: number;
    min_value: number;
    max_value_sum: number;
    min_value_sum: number;
    cost_exponent: number;
    cost_from_weight: number;
}
```

#### `SequencerProcessData`

The format of data from the DAVINCI sequencer:

```typescript
interface SequencerProcessData {
    processId: string;      // hex string
    address: string;        // hex string
    pubKeyX: string;        // decimal string (RTE format)
    pubKeyY: string;        // decimal string (RTE format)
    ballotMode: {
        numFields: number;
        uniqueValues: boolean;
        maxValue: string;
        minValue: string;
        maxValueSum: string;
        minValueSum: string;
        costExponent: number;
        costFromWeight: boolean;
    };
}
```

#### `BallotConfig`

The circuit ballot configuration format:

```typescript
interface BallotConfig {
    numFields: number;
    uniqueValues: number;   // 0 or 1
    maxValue: number;
    minValue: number;
    maxValueSum: number;
    minValueSum: number;
    costExponent: number;
    costFromWeight: number; // 0 or 1
}
```

## Complete Example

Here's a complete example of generating a ballot proof:

```typescript
import { BallotBuilder } from '@vocdoni/davinci-circom';
import type { SequencerProcessData } from '@vocdoni/davinci-circom';
import * as snarkjs from 'snarkjs';

async function generateBallotProof() {
    // 1. Initialize the builder
    const builder = await BallotBuilder.build();

    // 2. Get process data from sequencer (example data)
    const sequencerData: SequencerProcessData = {
        processId: "a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000010",
        address: "0xA62E32147e9c1EA76DA552Be6E0636F1984143AF",
        pubKeyX: "19485953556403312941904393378091455968053684322142533232252221507246354347357",
        pubKeyY: "16219479350243308044593790248520319281271283090548119799482663113896815349782",
        ballotMode: {
            numFields: 2,
            uniqueValues: false,
            maxValue: "3",
            minValue: "0",
            maxValueSum: "6",
            minValueSum: "0",
            costExponent: 0,
            costFromWeight: false,
        }
    };

    // 3. Define your vote
    const fields = [1, 2];  // Your vote values
    const weight = 1;       // Your voting weight

    // 4. Generate circuit inputs
    const inputs = builder.generateInputsFromSequencer(
        sequencerData,
        fields,
        weight
    );

    console.log("Vote ID:", inputs.vote_id);
    console.log("Inputs Hash:", inputs.inputs_hash);

    // 5. Generate the proof using snarkjs
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        inputs,
        'path/to/ballot_proof.wasm',
        'path/to/ballot_proof.zkey'
    );

    // 6. Verify the proof (optional, for testing)
    const vkey = JSON.parse(fs.readFileSync('path/to/ballot_proof_vkey.json', 'utf-8'));
    const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    console.log("Proof valid:", isValid);

    // 7. Return proof data to send to sequencer
    return {
        proof,
        publicSignals,
        voteId: inputs.vote_id,
        k: inputs.k,  // Keep this secret but you need it to prove ownership
    };
}
```

## Understanding Coordinate Formats

The DAVINCI protocol uses two different coordinate systems for BabyJubJub elliptic curve points:

### Reduced Twisted Edwards (RTE) - Used by Gnark/Sequencer

The DAVINCI sequencer is built with Go and uses Gnark's BabyJubJub implementation, which uses a "reduced" form of Twisted Edwards coordinates.

### Standard Twisted Edwards (TE) - Used by Circom/circomlibjs

The circom circuits and circomlibjs use the standard Twisted Edwards form, which is the format used by iden3.

### Conversion Formula

The conversion between formats is:
- **RTE → TE:** `x_TE = x_RTE / (-f)`, `y_TE = y_RTE`
- **TE → RTE:** `x_RTE = x_TE * (-f)`, `y_RTE = y_TE`

Where `f = 6360561867910373094066688120553762416144456282423235903351243436111059670888`

This package handles this conversion automatically when you use `generateInputsFromSequencer()` or `createPubKeyFromRTE()`.

## Constants

```typescript
import { FIELD_MODULUS, SCALING_FACTOR } from '@vocdoni/davinci-circom';

// BN254 scalar field modulus
FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

// Scaling factor for RTE <-> TE conversion
SCALING_FACTOR = 6360561867910373094066688120553762416144456282423235903351243436111059670888n
```

## Browser Usage

This package works in both Node.js and browser environments. For browser usage, you may need to include a polyfill for `crypto.getRandomValues` (most modern browsers support it natively).

```typescript
// In a web worker or main thread
import { BallotBuilder } from '@vocdoni/davinci-circom';

const builder = await BallotBuilder.build();
// ... use as normal
```

## Running Tests

The tests require circuit artifacts (WASM and zkey files) to be present in the repository's `artifacts/` directory.

```bash
# From the js/ directory
npm install
npm test

# Or from the repository root
make test-js
```

The circuit artifacts are committed to the repository in the `artifacts/` directory and are shared between:
- The JS package tests
- The webapp (copied at build time)
- Go tests

## Dependencies

- `circomlibjs` - Poseidon hash and BabyJubJub curve operations
- `ffjavascript` - Finite field arithmetic
- `snarkjs` - For proof generation (peer dependency)

## License

See the main repository LICENSE file.
