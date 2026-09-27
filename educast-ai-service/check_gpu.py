import torch

print("=== Diagnostic GPU ===")
is_available = torch.cuda.is_available()
print(f"CUDA disponible ? : {is_available}")

if is_available:
    print(f"Nom du GPU détecté : {torch.cuda.get_device_name(0)}")
    print(f"Version de CUDA (PyTorch) : {torch.version.cuda}")  # type: ignore[attr-defined]
else:
    print("GPU non détecté par PyTorch. Cela signifie que la version installée est probablement 'cpu-only'.")

print("\n=== Version de PyTorch ===")
print(f"PyTorch version : {torch.__version__}")