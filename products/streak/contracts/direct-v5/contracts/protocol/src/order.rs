use super::*;
use ckb_std::ckb_types::packed::Script;

// The reserve returns to the owner on admission. At most 1 CKB pays the
// admission/refund network fee; even a 59-byte owner lock fits the remainder.
const QUEUE_RESERVE: u64 = 101 * CKB;
const MAX_FEE: u64 = CKB;
pub struct Order {
    pub owner: Script,
    pub lines: Vec<([u8; 32], u64, Ticket)>,
    pub expiry: u64,
    pub capacity: u64,
}
fn digest(data: &[u8]) -> [u8; 32] {
    let mut out = [0; 32];
    let mut h = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    h.update(data);
    h.finalize(&mut out);
    out
}
pub fn read(index: usize, code_hash: &[u8]) -> R<Order> {
    need(
        load_cell_type(index, Source::Input)
            .map_err(|_| 5)?
            .is_none(),
        5,
    )?;
    let lock = load_cell_lock(index, Source::Input).map_err(|_| 5)?;
    let args = lock.args().raw_data();
    need(
        lock.code_hash().as_slice() == code_hash
            && lock.hash_type().as_slice() == [4]
            && args.len() == 33
            && args[0] == 5,
        6,
    )?;
    let data = load_cell_data(index, Source::Input).map_err(|_| 5)?;
    need(args[1..] == digest(&data) && data.len() >= 4, 5)?;
    let count = data[1] as usize;
    let owner_len = u16::from_le_bytes([data[2], data[3]]) as usize;
    // v1, count, owner byte length, Molecule owner script, expiry, selection digest,
    // then count * (market type hash, cutoff, outcome, principal).
    need(
        data[0] == 1
            && (1..=8).contains(&count)
            && owner_len <= 112
            && data.len() == 4 + owner_len + 40 + count * 49,
        5,
    )?;
    let owner = Script::from_slice(&data[4..4 + owner_len]).map_err(|_| 5)?;
    need(owner.args().raw_data().len() <= MAX_LOCK_ARGS, 6)?;
    let owner_hash: [u8; 32] = owner.calc_script_hash().as_slice().try_into().unwrap();
    let expiry = n(&data, 4 + owner_len);
    let mut capacity = QUEUE_RESERVE;
    let mut lines = vec![];
    let mut earliest = u64::MAX;
    for j in 0..count {
        let offset = 44 + owner_len + j * 49;
        let market: [u8; 32] = data[offset..offset + 32].try_into().unwrap();
        let cutoff = n(&data, offset + 32);
        let ticket = Ticket {
            owner: owner_hash,
            outcome: data[offset + 40],
            amount: n(&data, offset + 41),
        };
        need(
            ticket.outcome < 3
                && ticket.amount >= 100 * CKB
                && ticket.amount <= 1_000_000 * CKB
                && cutoff > 0
                && !lines.iter().any(|(hash, _, _)| *hash == market),
            9,
        )?;
        capacity = add(capacity, add(STORAGE, ticket.amount)?)?;
        earliest = core::cmp::min(earliest, cutoff);
        lines.push((market, cutoff, ticket));
    }
    need(
        expiry == earliest && load_cell_capacity(index, Source::Input).map_err(|_| 9)? == capacity,
        9,
    )?;
    Ok(Order {
        owner,
        lines,
        expiry,
        capacity,
    })
}

pub fn authorize(ticket: &Ticket, market: &[u8], code_hash: &[u8]) -> R<()> {
    // Fulfillment layout fixes the sole order to input zero. Its lock validates
    // the complete slip, so no per-market authorization can partially consume it.
    let order = read(0, code_hash).map_err(|_| 6)?;
    need(
        order
            .lines
            .iter()
            .any(|(hash, _, t)| hash == market && t == ticket),
        6,
    )
}

pub fn validate() -> R<()> {
    let script = load_script().map_err(|_| 5)?;
    let order = read(0, script.code_hash().as_slice())?;
    need(
        load_cell_lock(0, Source::Input).map_err(|_| 5)? == script,
        6,
    )?;
    let ni = count(Source::Input)?;
    let no = count(Source::Output)?;
    let owner = order.owner.calc_script_hash();
    if ni == 1 && no == 1 {
        // Anyone may return the funds after expiry, but nobody can grief-cancel
        // a live order. The absolute timestamp since is enforced by consensus.
        let since = load_input_since(0, Source::Input).map_err(|_| 7)?;
        need(
            since >> 56 == 0x40 && since & 0x00ff_ffff_ffff_ffff >= order.expiry.div_ceil(1000),
            7,
        )?;
        let capacity = load_cell_capacity(0, Source::Output).map_err(|_| 9)?;
        need(
            capacity <= order.capacity && order.capacity - capacity <= MAX_FEE,
            9,
        )?;
        return plain(0, owner.as_slice(), capacity);
    }
    need(
        ni == order.lines.len() + 1 && no == order.lines.len() + 1,
        5,
    )?;
    for (j, (hash, cutoff, ticket)) in order.lines.iter().enumerate() {
        let input = load_cell_type(j + 1, Source::Input)
            .map_err(|_| 5)?
            .ok_or(5)?;
        let output = load_cell_type(j, Source::Output).map_err(|_| 5)?.ok_or(5)?;
        let args = input.args().raw_data();
        need(
            input == output
                && input.calc_script_hash().as_slice() == hash
                && input.code_hash() == script.code_hash()
                && input.hash_type().as_slice() == [4]
                && args.len() == 172
                && n(&args, 68) == *cutoff,
            6,
        )?;
        let before = load_cell_data(j + 1, Source::Input).map_err(|_| 5)?;
        let after = load_cell_data(j, Source::Output).map_err(|_| 5)?;
        let (_, _, pending) = shard(&after)?;
        need(pending.as_ref() == Some(ticket), 8)?;
        shard(&before)?;
        need(
            load_cell_capacity(j, Source::Output).map_err(|_| 9)?
                == add(
                    load_cell_capacity(j + 1, Source::Input).map_err(|_| 9)?,
                    add(STORAGE, ticket.amount)?,
                )?,
            9,
        )?;
    }
    let returned = load_cell_capacity(no - 1, Source::Output).map_err(|_| 9)?;
    need(
        returned <= QUEUE_RESERVE && QUEUE_RESERVE - returned <= MAX_FEE,
        9,
    )?;
    plain(no - 1, owner.as_slice(), returned)
}
