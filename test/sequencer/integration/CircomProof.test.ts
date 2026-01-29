import { Groth16Proof, CircomProof, ProofInputs } from '../../../src/sequencer';
import { VocdoniSequencerService } from '../../../src/sequencer/SequencerService';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

const finalInputs: ProofInputs = {
  fields: ['14', '5', '4', '7', '7', '0', '0', '0'],
  num_fields: '5',
  unique_values: '0',
  max_value: '16',
  min_value: '0',
  max_value_sum: '1280',
  min_value_sum: '5',
  cost_exponent: '2',
  cost_from_weight: '0',
  address: '534740417394897960836811392147237753970198909342',
  weight: '10',
  process_id: '36071105334984870228102641600278424081824666121436262585075111806631936',
  vote_id: '96134477480967460200534348071535817630951961041',
  encryption_pubkey: [
    '12224737978337629155968196802861154212447347024521187935308931342505886358431',
    '15406374707221952345208570102875720476127720338785386457566564519679669575252',
  ],
  k: '1088573416647744163120195764980052077658871325538',
  cipherfields: [
    // Each field has format [[c1_x, c1_y], [c2_x, c2_y]]
    [
      ['7524740478956440977876029925323471670165263478838586761826061757403029332542', '16101453353244893742467786036849294520259278528055210088588258283820907759862'],
      ['1741815243991062718901350601128520433330655819940584197173646787246353716769', '1386426381430363703563673793066645553248771032567697856598652784499659251412']
    ],
    [
      ['13832006967571051971709367561270749953330136249211576091651789636794992159097', '2216965828570846152775675289122259418467998394705412039407396152552238014047'],
      ['1146709151441250122413090367969440858743908390891996407682016086848274938642', '12272804275917768010829255945750239212971611180335029839477972404084183914881']
    ],
    [
      ['18258797557366913562754319118645166802461208398207718227386978175017292256147', '5585625801667460246126338253460392884500821091841925710775541301565174303824'],
      ['16808761174059981270797245164214508304720431615613525902452413212302355969327', '5174654336196530844876585143188743454240670722105292707347044097047498994743']
    ],
    [
      ['15308509547637134323207085099613292774923811379047396093048436643792680977775', '13555428378683486154799787261609561209600223856409809833679440837713889937672'],
      ['13999073812626058085076270054771348975213330167420847630210841307160642840813', '3100796682788168178219122728355956819071655793295620065730340375756969237414']
    ],
    [
      ['1402014915098456934867000376291582097714644325066093728417367376749702662587', '11528939503350070078764374982283751806674373855910222737915818745530791530541'],
      ['3211326523086420082153286381960496662940308054624830301396361997356648633796', '6546043035692869760701158746439502504572155643711423770448174716114377138091']
    ],
    [
      ['8436677257486488346417709571235843043320729810949701714465767570209626834416', '13354511263500233537225391566644384463212593626940733095769380191036711842705'],
      ['13157620027466970524666299927768501180727837894735476161404888777546088542126', '13228825150523518556366849069725662706767638009308469633540541299284834956314']
    ],
    [
      ['11769074972595715318362409323109836454731095601653658506410785816592019897572', '20149971220764360220907389765892871500074380767543412946681511439965599464680'],
      ['11130629193817948321610902969189141399142835289516295614075729326218289582515', '12312076208284600500426503382521350012643364442888551990288090393207188087721']
    ],
    [
      ['2461445100793063077018941805463284568311737706135868752150448034162749453148', '15187602647376473610300607805587245096152652167481738641960142816611200053412'],
      ['5901971402483155041752674778443481914893659173241295267917894116128680946589', '10121088435939498258507635936823928273549018373563009228557672874395872383622']
    ],
  ],
  inputs_hash: '11184631649084464226213756148234839699763816260446970410086343091545010747393',
};

describe('CircomProofService Integration', () => {
  let service: CircomProof;
  let proof: Groth16Proof;
  let publicSignals: string[];
  let api: VocdoniSequencerService;

  beforeAll(async () => {
    api = new VocdoniSequencerService(process.env.SEQUENCER_API_URL!);
    const info = await api.getInfo();

    service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
    });
  });

  it('builds the ProofInputs and runs fullProve()', async () => {
    ({ proof, publicSignals } = await service.generate(finalInputs));

    // pi_a
    expect(Array.isArray(proof.pi_a)).toBe(true);
    expect(proof.pi_a).toHaveLength(3);
    proof.pi_a.forEach(x => expect(typeof x).toBe('string'));
    // pi_b
    expect(Array.isArray(proof.pi_b)).toBe(true);
    expect(proof.pi_b).toHaveLength(3);
    proof.pi_b.forEach(pair => {
      expect(Array.isArray(pair)).toBe(true);
      expect(pair).toHaveLength(2);
      pair.forEach(x => expect(typeof x).toBe('string'));
    });
    // pi_c
    expect(Array.isArray(proof.pi_c)).toBe(true);
    expect(proof.pi_c).toHaveLength(3);
    proof.pi_c.forEach(x => expect(typeof x).toBe('string'));

    // protocol & curve
    expect(typeof proof.protocol).toBe('string');
    expect(proof.protocol).toBe('groth16');
    expect(typeof proof.curve).toBe('string');
    expect(proof.curve).toBe('bn128');

    // publicSignals
    expect(Array.isArray(publicSignals)).toBe(true);
    expect(publicSignals).toHaveLength(1);
    publicSignals.forEach(sig => {
      expect(typeof sig).toBe('string');
      expect(() => BigInt(sig)).not.toThrow();
    });
    // must equal the inputs_hash we built
    expect(publicSignals[0]).toBe(finalInputs.inputs_hash);
  }, 60_000);

  it('pulls down the vkey and verifies()', async () => {
    const ok = await service.verify(proof, publicSignals);
    expect(ok).toBe(true);
  }, 30_000);
});

describe('CircomProofService Hash Verification Integration', () => {
  let api: VocdoniSequencerService;
  let info: any;

  beforeAll(async () => {
    api = new VocdoniSequencerService(process.env.SEQUENCER_API_URL!);
    info = await api.getInfo();
  });

  it('should verify circuit WASM hash when provided', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      wasmHash: info.circuitHash,
    });

    const { proof, publicSignals } = await service.generate(finalInputs);

    expect(proof).toBeDefined();
    expect(publicSignals).toBeDefined();
    expect(publicSignals[0]).toBe(finalInputs.inputs_hash);
  }, 60_000);

  it('should verify proving key hash when provided', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      zkeyHash: info.provingKeyHash,
    });

    const { proof, publicSignals } = await service.generate(finalInputs);

    expect(proof).toBeDefined();
    expect(publicSignals).toBeDefined();
    expect(publicSignals[0]).toBe(finalInputs.inputs_hash);
  }, 60_000);

  it('should verify verification key hash when provided', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      vkeyHash: info.verificationKeyHash,
    });

    const { proof, publicSignals } = await service.generate(finalInputs);
    const ok = await service.verify(proof, publicSignals);

    expect(ok).toBe(true);
  }, 60_000);

  it('should verify all hashes when provided', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      wasmHash: info.circuitHash,
      zkeyHash: info.provingKeyHash,
      vkeyHash: info.verificationKeyHash,
    });

    const { proof, publicSignals } = await service.generate(finalInputs);
    const ok = await service.verify(proof, publicSignals);

    expect(proof).toBeDefined();
    expect(publicSignals).toBeDefined();
    expect(publicSignals[0]).toBe(finalInputs.inputs_hash);
    expect(ok).toBe(true);
  }, 60_000);

  it('should work without hash verification (backward compatibility)', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      // No hashes provided
    });

    const { proof, publicSignals } = await service.generate(finalInputs);
    const ok = await service.verify(proof, publicSignals);

    expect(proof).toBeDefined();
    expect(publicSignals).toBeDefined();
    expect(publicSignals[0]).toBe(finalInputs.inputs_hash);
    expect(ok).toBe(true);
  }, 60_000);

  it('should throw error when circuit WASM hash verification fails', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      wasmHash: 'invalid_hash',
    });

    await expect(service.generate(finalInputs)).rejects.toThrow(
      'Hash verification failed for circuit.wasm'
    );
  }, 30_000);

  it('should throw error when proving key hash verification fails', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      zkeyHash: 'invalid_hash',
    });

    await expect(service.generate(finalInputs)).rejects.toThrow(
      'Hash verification failed for proving_key.zkey'
    );
  }, 30_000);

  it('should throw error when verification key hash verification fails', async () => {
    const service = new CircomProof({
      wasmUrl: info.circuitUrl,
      zkeyUrl: info.provingKeyUrl,
      vkeyUrl: info.verificationKeyUrl,
      vkeyHash: 'invalid_hash',
    });

    const { proof, publicSignals } = await service.generate(finalInputs);

    await expect(service.verify(proof, publicSignals)).rejects.toThrow(
      'Hash verification failed for verification_key.json'
    );
  }, 60_000);
});
