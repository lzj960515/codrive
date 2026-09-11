from money import amount

def render(value):
    return amount(value)["amountCents"]
