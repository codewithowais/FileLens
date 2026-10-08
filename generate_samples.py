"""
Sample generator for FileLens.
Generates realistic multi-component test audio:
- Main Voice (Foreground speaker)
- Background Human Voices (Secondary ambient chatter)
- Traffic / Vehicle rumble
- Fan / AC stationary hum and air hiss
- 60 Hz electrical mains hum
"""
import math
import os
import random
import struct
import wave

SAMPLE_RATE = 44100
DURATION = 12.0  # 12 seconds
NUM_SAMPLES = int(SAMPLE_RATE * DURATION)


def synth_formant(f0, f1, f2, f3, t, env):
    """Simple formant speech synthesizer for vocal vowel synthesis."""
    if env <= 0:
        return 0.0
    # Voice source: glottal pulse approximation with rich harmonics
    src = 0.0
    for h in range(1, 15):
        # Harmonic amplitudes roll off
        amp = 1.0 / (h ** 0.8)
        phase = 2.0 * math.pi * (f0 * h) * t
        src += amp * math.sin(phase)

    # Formant resonance filters approximation
    # Simple acoustic resonance shaping
    w1 = math.exp(-(((f0 - f1) / 300.0) ** 2))
    w2 = math.exp(-(((f0 * 2 - f2) / 500.0) ** 2))
    w3 = math.exp(-(((f0 * 4 - f3) / 800.0) ** 2))
    formant_gain = 0.5 + 0.3 * w1 + 0.3 * w2 + 0.2 * w3
    return src * formant_gain * env * 0.3


def main():
    os.makedirs("samples", exist_ok=True)
    random.seed(42)

    left_samples = [0.0] * NUM_SAMPLES
    right_samples = [0.0] * NUM_SAMPLES

    # We also keep individual stems to allow direct verification if needed!
    main_voice_buf = [0.0] * NUM_SAMPLES
    bg_voice_buf = [0.0] * NUM_SAMPLES
    traffic_buf = [0.0] * NUM_SAMPLES
    fan_buf = [0.0] * NUM_SAMPLES
    hum_buf = [0.0] * NUM_SAMPLES

    # 1. Synthesize Main Voice (Foreground Speaker)
    # Speaks 3 distinct phrases: "Hello everyone", "Welcome to the podcast", "Can you hear the background?"
    words = [
        (0.8, 1.3, 135, 750, 1200, 2600),   # "Hel-"
        (1.35, 1.9, 130, 500, 1800, 2800),  # "-lo"
        (2.1, 2.6, 140, 600, 1400, 2500),   # "ev-"
        (2.65, 3.2, 125, 450, 1900, 2700),  # "-ryone"
        (4.2, 4.8, 138, 700, 1300, 2600),   # "Wel-"
        (4.85, 5.4, 132, 550, 1750, 2750),  # "-come"
        (5.6, 6.2, 128, 480, 1600, 2500),   # "here"
        (7.0, 7.6, 135, 700, 1250, 2600),   # "This"
        (7.65, 8.2, 142, 600, 1500, 2700),  # "is"
        (8.3, 9.0, 130, 500, 1850, 2800),   # "clean"
        (9.2, 9.8, 122, 650, 1350, 2550),   # "sound"
    ]

    for start_t, end_t, f0_base, f1, f2, f3 in words:
        start_idx = int(start_t * SAMPLE_RATE)
        end_idx = int(end_t * SAMPLE_RATE)
        span = end_idx - start_idx
        for i in range(start_idx, min(end_idx, NUM_SAMPLES)):
            t = i / SAMPLE_RATE
            local_progress = (i - start_idx) / span
            # Hanning window envelope for syllable
            env = 0.5 * (1.0 - math.cos(2.0 * math.pi * local_progress))
            # Natural speech pitch inflection
            pitch_bend = math.sin(math.pi * local_progress) * 12.0
            val = synth_formant(f0_base + pitch_bend, f1, f2, f3, t, env)
            main_voice_buf[i] += val

    # 2. Synthesize Background Human Voices (Chatter / Ambient Cafe Babble)
    # 2 secondary speakers murmuring continuously at a lower volume (-14 dB)
    bg_words = [
        (0.3, 1.5, 185, 600, 1600, 2800),
        (1.8, 3.0, 195, 500, 1700, 2900),
        (3.3, 4.5, 175, 700, 1500, 2700),
        (4.8, 6.0, 190, 550, 1800, 2850),
        (6.3, 7.8, 180, 650, 1650, 2750),
        (8.0, 9.5, 200, 520, 1750, 2950),
        (9.8, 11.2, 185, 580, 1620, 2800),
        # Second chatter overlapping
        (1.0, 2.4, 110, 400, 1200, 2400),
        (2.8, 4.2, 115, 450, 1300, 2500),
        (5.0, 6.5, 108, 420, 1250, 2450),
        (7.2, 8.8, 112, 480, 1350, 2550),
        (9.0, 10.8, 105, 410, 1220, 2420),
    ]

    for start_t, end_t, f0_base, f1, f2, f3 in bg_words:
        start_idx = int(start_t * SAMPLE_RATE)
        end_idx = int(end_t * SAMPLE_RATE)
        span = end_idx - start_idx
        for i in range(start_idx, min(end_idx, NUM_SAMPLES)):
            t = i / SAMPLE_RATE
            local_progress = (i - start_idx) / span
            env = 0.5 * (1.0 - math.cos(2.0 * math.pi * local_progress))
            val = synth_formant(f0_base, f1, f2, f3, t, env) * 0.18  # Soft diffuse babble
            bg_voice_buf[i] += val

    # 3. Synthesize Traffic / Vehicle Rumble (Low frequencies 35 - 120 Hz with car pass-by)
    for i in range(NUM_SAMPLES):
        t = i / SAMPLE_RATE
        # Car passing by peaking around 6.5s
        pass_by = 0.4 + 0.6 * math.exp(-(((t - 6.5) / 2.5) ** 2))
        engine_f1 = 45.0 + 8.0 * math.sin(t * 1.5)
        engine_f2 = 90.0 + 16.0 * math.sin(t * 1.5)
        # Low rumble harmonics
        rumble = (
            math.sin(2.0 * math.pi * engine_f1 * t) * 0.5
            + math.sin(2.0 * math.pi * engine_f2 * t) * 0.35
            + math.sin(2.0 * math.pi * (engine_f1 * 1.5) * t) * 0.2
        )
        # Add random road tire texture
        road_hiss = (random.random() * 2.0 - 1.0) * 0.08
        traffic_buf[i] = (rumble * 0.35 + road_hiss) * pass_by

    # 4. Synthesize Fan / AC (Steady motor hum + constant broadband air hiss)
    for i in range(NUM_SAMPLES):
        t = i / SAMPLE_RATE
        # Motor blade pass frequency (72 Hz and 144 Hz)
        fan_motor = (
            math.sin(2.0 * math.pi * 72.0 * t) * 0.12
            + math.sin(2.0 * math.pi * 144.0 * t) * 0.08
            + math.sin(2.0 * math.pi * 216.0 * t) * 0.04
        )
        # Steady air rush hiss
        air_rush = (random.random() * 2.0 - 1.0) * 0.07
        fan_buf[i] = fan_motor + air_rush

    # 5. Synthesize 60 Hz Mains Hum (Precision electrical buzz)
    for i in range(NUM_SAMPLES):
        t = i / SAMPLE_RATE
        hum = (
            math.sin(2.0 * math.pi * 60.0 * t) * 0.15
            + math.sin(2.0 * math.pi * 120.0 * t) * 0.09
            + math.sin(2.0 * math.pi * 180.0 * t) * 0.05
            + math.sin(2.0 * math.pi * 240.0 * t) * 0.025
        )
        hum_buf[i] = hum

    # Mix together into master composite track!
    for i in range(NUM_SAMPLES):
        # Master mix: Main voice + Background People + Traffic + Fan + Hum
        mixed = (
            main_voice_buf[i] * 1.1
            + bg_voice_buf[i] * 1.0
            + traffic_buf[i] * 0.75
            + fan_buf[i] * 0.65
            + hum_buf[i] * 0.5
        )
        # Slight stereo separation for realistic acoustics
        left_samples[i] = mixed + bg_voice_buf[i] * 0.1 - traffic_buf[i] * 0.05
        right_samples[i] = mixed - bg_voice_buf[i] * 0.1 + traffic_buf[i] * 0.05

    # Write WAV file
    out_wav_path = "samples/sample_interview_with_noise.wav"
    with wave.open(out_wav_path, "wb") as wav_file:
        wav_file.setnchannels(2)
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for i in range(NUM_SAMPLES):
            l = max(-32767, min(32767, int(left_samples[i] * 32767.0)))
            r = max(-32767, min(32767, int(right_samples[i] * 32767.0)))
            frames.extend(struct.pack("<hh", l, r))
        wav_file.writeframes(frames)

    print(f"Generated sample audio: {out_wav_path} ({DURATION}s, {SAMPLE_RATE}Hz stereo)")


if __name__ == "__main__":
    main()
